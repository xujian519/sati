#!/usr/bin/env node
/**
 * turnkey-capture.js
 *
 * Passive observer (Obs-A in _drift/cursor-extension-feasibility/README.md).
 * Reads hook payload from stdin, appends a single JSONL line to
 *   ~/.turnkey/inbox.jsonl
 *
 * Pure Node, no deps, mkdir-lock for concurrent writers (mindflow pattern).
 * Failures are non-fatal: hooks must never block the agent.
 *
 * Usage (Cursor invokes):
 *   node ~/.cursor/hooks/turnkey-capture.js --event beforeSubmitPrompt
 *   node ~/.cursor/hooks/turnkey-capture.js --event afterAgentResponse
 *
 * Self-check:
 *   node turnkey-capture.js --self-check
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TURNKEY_HOME = process.env.TURNKEY_HOME || path.join(os.homedir(), '.turnkey');
const INBOX        = path.join(TURNKEY_HOME, 'inbox.jsonl');
const LOG_DIR      = path.join(TURNKEY_HOME, 'logs');
const SELF_LOG     = path.join(LOG_DIR, 'turnkey-capture.log');
const LOCK_DIR     = path.join(TURNKEY_HOME, '.inbox.lock');
const MAX_LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS    = 25;
const MAX_LINE_BYTES   = 64 * 1024;

function args() {
  const argv = process.argv.slice(2);
  const out = { event: null, selfCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event' && argv[i+1]) { out.event = argv[++i]; }
    else if (a === '--self-check')    { out.selfCheck = true; }
  }
  return out;
}

function ensureDirs() {
  fs.mkdirSync(TURNKEY_HOME, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logSelf(msg) {
  try {
    ensureDirs();
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(SELF_LOG, line);
  } catch (_) { /* swallow */ }
}

function acquireLock() {
  const start = Date.now();
  while (Date.now() - start < MAX_LOCK_WAIT_MS) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      const ageMs = (() => {
        try { return Date.now() - fs.statSync(LOCK_DIR).mtimeMs; }
        catch (_) { return 0; }
      })();
      if (ageMs > 5000) {
        try { fs.rmdirSync(LOCK_DIR); } catch (_) {}
        continue;
      }
      const wait = LOCK_RETRY_MS;
      const waitUntil = Date.now() + wait;
      while (Date.now() < waitUntil) { /* spin briefly */ }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch (_) {}
}

function appendLine(obj) {
  let line = JSON.stringify(obj);
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    obj.truncated = true;
    if (obj.payload && obj.payload.prompt)   { obj.payload.prompt   = String(obj.payload.prompt).slice(0, 4000)   + '…[truncated]'; }
    if (obj.payload && obj.payload.response) { obj.payload.response = String(obj.payload.response).slice(0, 4000) + '…[truncated]'; }
    line = JSON.stringify(obj);
  }
  if (!acquireLock()) {
    logSelf('lock acquisition failed; appending without lock');
  }
  try {
    fs.appendFileSync(INBOX, line + '\n');
  } finally {
    releaseLock();
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    const timer = setTimeout(() => resolve(data), 1500);
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 1024 * 1024) {
        clearTimeout(timer);
        return resolve(data + '…[truncated-stdin]');
      }
      data += chunk;
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function tryParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return { _raw: s.slice(0, 1000) }; }
}

function pickRunlogContext() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(TURNKEY_HOME, 'runlog.json'), 'utf8'));
    return { ticket_id: r.ticket_id || null, current_stage: r.current_stage || null };
  } catch (_) {
    return { ticket_id: null, current_stage: null };
  }
}

async function selfCheck() {
  ensureDirs();
  const probeFile = path.join(LOG_DIR, '.self-check-probe');
  fs.writeFileSync(probeFile, 'ok');
  fs.unlinkSync(probeFile);

  const got = acquireLock();
  if (!got) { console.error('FAIL: cannot acquire lock dir'); process.exit(1); }
  releaseLock();

  const sample = {
    ts: new Date().toISOString(),
    type: 'self_check',
    event: 'self-check',
    pid: process.pid,
    node: process.version,
    turnkey_home: TURNKEY_HOME
  };
  appendLine(sample);

  console.log(JSON.stringify({ ok: true, inbox: INBOX, sample }));
  process.exit(0);
}

async function main() {
  const a = args();
  if (a.selfCheck) return selfCheck();

  ensureDirs();
  const raw     = await readStdin();
  const payload = tryParse(raw);
  const ctx     = pickRunlogContext();

  const record = {
    ts: new Date().toISOString(),
    type: 'cursor_hook',
    event: a.event || 'unknown',
    ticket_id: ctx.ticket_id,
    current_stage: ctx.current_stage,
    workspace_roots: payload && payload.workspace_roots || null,
    generation_id:   payload && payload.generation_id   || null,
    payload: payload || null
  };

  try {
    appendLine(record);
  } catch (e) {
    logSelf(`appendLine error: ${e.message}`);
  }
  process.exit(0);
}

main().catch((e) => {
  logSelf(`uncaught: ${e && e.message}`);
  process.exit(0);
});
