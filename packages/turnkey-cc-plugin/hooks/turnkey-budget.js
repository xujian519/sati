#!/usr/bin/env node
/**
 * turnkey-budget.js
 *
 * Passive observer for LLM context length. Hooked to afterAgentResponse.
 * Estimates tokens added per turn from the cursor hook payload, RMWs the
 * runlog.json `context_budget` segment, and emits inbox.jsonl signals when
 * a warning threshold is crossed.
 *
 * Why: turnkey lets the agent read prior-stage artifacts instead of scrolling
 * back through chat. To enforce that proactively we need a numeric budget
 * the SKILLs can read at each stage entry. This hook is the tracker.
 *
 * Pure Node, no deps. Failures are non-fatal: hooks must never block the agent.
 *
 * Usage:
 *   node ~/.cursor/hooks/turnkey-budget.js --event afterAgentResponse
 *   node ~/.cursor/hooks/turnkey-budget.js --self-check
 *
 * Estimation strategy (P0, deliberately coarse):
 *   tokens ≈ utf8_byte_length(prompt + response) / CHARS_PER_TOKEN
 *   We use 3.0 (vs the "usual" 4.0) to be conservative — over-estimate
 *   so we warn early. Replace with tiktoken in a later pass.
 *
 * Threshold ladder (against model_window from runlog.context_budget):
 *   green  : < 40 %
 *   yellow : 40–60 %  → soft suggestion at next stage entry
 *   orange : 60–80 %  → forced digest-only mode + AskUserQuestion
 *   red    : > 80 %   → halt-and-compact
 *
 * Compat: existing runlogs without `context_budget` are auto-migrated
 * with a default block on first invocation. Missing runlog → no-op.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TURNKEY_HOME = process.env.TURNKEY_HOME || path.join(os.homedir(), '.turnkey');
const RUNLOG       = path.join(TURNKEY_HOME, 'runlog.json');
const INBOX        = path.join(TURNKEY_HOME, 'inbox.jsonl');
const LOG_DIR      = path.join(TURNKEY_HOME, 'logs');
const SELF_LOG     = path.join(LOG_DIR, 'turnkey-budget.log');
const LOCK_DIR     = path.join(TURNKEY_HOME, '.inbox.lock');

const MAX_LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS    = 25;
const STDIN_MAX_BYTES  = 1024 * 1024;
const STDIN_TIMEOUT_MS = 1500;

const CHARS_PER_TOKEN = 3.0;

const DEFAULT_BUDGET = {
  model: 'unknown',
  model_window: 200000,
  yellow_pct: 0.40,
  orange_pct: 0.60,
  red_pct: 0.80,
  current_estimate: 0,
  level: 'green',
  per_stage: {},
  warnings: []
};

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
    fs.appendFileSync(SELF_LOG, `[${new Date().toISOString()}] ${msg}\n`);
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
      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* spin briefly */ }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch (_) {}
}

function appendInbox(obj) {
  const line = JSON.stringify(obj) + '\n';
  if (!acquireLock()) {
    logSelf('lock acquisition failed; appending without lock');
  }
  try {
    fs.appendFileSync(INBOX, line);
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
    const timer = setTimeout(() => resolve(data), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > STDIN_MAX_BYTES) {
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
  try { return JSON.parse(s); } catch (_) { return null; }
}

function estimateTokensFromPayload(rawStdin, parsedPayload) {
  // Prefer explicit prompt/response fields if present; otherwise fall back
  // to the full stdin byte length (covers cases where cursor sends a
  // different envelope shape).
  let chars = 0;
  if (parsedPayload && typeof parsedPayload === 'object') {
    if (typeof parsedPayload.prompt === 'string')   chars += Buffer.byteLength(parsedPayload.prompt,   'utf8');
    if (typeof parsedPayload.response === 'string') chars += Buffer.byteLength(parsedPayload.response, 'utf8');
    if (Array.isArray(parsedPayload.messages)) {
      for (const m of parsedPayload.messages) {
        if (m && typeof m.content === 'string') chars += Buffer.byteLength(m.content, 'utf8');
      }
    }
  }
  if (chars === 0 && rawStdin) {
    chars = Buffer.byteLength(rawStdin, 'utf8');
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function classifyLevel(budget) {
  const window = budget.model_window || DEFAULT_BUDGET.model_window;
  const ratio  = budget.current_estimate / window;
  if (ratio >= (budget.red_pct    ?? DEFAULT_BUDGET.red_pct))    return 'red';
  if (ratio >= (budget.orange_pct ?? DEFAULT_BUDGET.orange_pct)) return 'orange';
  if (ratio >= (budget.yellow_pct ?? DEFAULT_BUDGET.yellow_pct)) return 'yellow';
  return 'green';
}

function loadRunlog() {
  try { return JSON.parse(fs.readFileSync(RUNLOG, 'utf8')); }
  catch (_) { return null; }
}

function saveRunlog(r) {
  // Atomic write: tmp + rename. runlog has weak concurrency guarantees
  // (per INBOX-BUS.md only one skill runs at a time), but a partial-write
  // is still worth avoiding under crash/ctrl-c.
  const tmp = RUNLOG + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, RUNLOG);
}

function ensureBudget(r) {
  if (!r.context_budget || typeof r.context_budget !== 'object') {
    r.context_budget = JSON.parse(JSON.stringify(DEFAULT_BUDGET));
    return { migrated: true };
  }
  for (const k of Object.keys(DEFAULT_BUDGET)) {
    if (r.context_budget[k] === undefined) r.context_budget[k] = DEFAULT_BUDGET[k];
  }
  return { migrated: false };
}

function tickBudget(r, addedTokens, event) {
  const ctx = ensureBudget(r);
  const stage = r.current_stage || 'unknown';
  const prevLevel = r.context_budget.level;

  r.context_budget.current_estimate = (r.context_budget.current_estimate || 0) + addedTokens;
  if (!r.context_budget.per_stage[stage]) {
    r.context_budget.per_stage[stage] = { chat_tokens_added: 0, compacted_to_digest: null };
  }
  r.context_budget.per_stage[stage].chat_tokens_added += addedTokens;

  const newLevel = classifyLevel(r.context_budget);
  r.context_budget.level = newLevel;

  let warningEmitted = null;
  if (newLevel !== prevLevel && newLevel !== 'green') {
    warningEmitted = {
      ts: new Date().toISOString(),
      level: newLevel,
      current_estimate: r.context_budget.current_estimate,
      ratio: +(r.context_budget.current_estimate / r.context_budget.model_window).toFixed(3),
      msg: warningMessageFor(newLevel)
    };
    r.context_budget.warnings = r.context_budget.warnings || [];
    r.context_budget.warnings.push(warningEmitted);
    if (r.context_budget.warnings.length > 50) {
      r.context_budget.warnings = r.context_budget.warnings.slice(-50);
    }
  }

  return { migrated: ctx.migrated, prevLevel, newLevel, warningEmitted };
}

function warningMessageFor(level) {
  switch (level) {
    case 'yellow':
      return 'context ~40% used — at next stage entry, prefer reading prior-stage summaries over chat scrollback.';
    case 'orange':
      return 'context ~60% used — sub-skills should read digest only; prompt user to compact via P1 turnkey-digest.';
    case 'red':
      return 'context ~80% used — halt before next stage; force compaction or hand off to a fresh session.';
    default:
      return '';
  }
}

async function selfCheck() {
  ensureDirs();

  // 1. probe stdin parser with a synthetic payload
  const sample = JSON.stringify({ prompt: 'hello world', response: 'hi there' });
  const parsed = tryParse(sample);
  const tokens = estimateTokensFromPayload(sample, parsed);
  if (tokens <= 0) { console.error('FAIL: token estimate <= 0'); process.exit(1); }

  // 2. probe lock acquire/release
  if (!acquireLock()) { console.error('FAIL: cannot acquire lock'); process.exit(1); }
  releaseLock();

  // 3. probe RMW on a temp runlog (does NOT touch the real one)
  const tmpRunlog = path.join(TURNKEY_HOME, '.budget-self-check.runlog.json');
  const seed = { ticket_id: 'self-check', current_stage: 'onboard', funnel: {} };
  fs.writeFileSync(tmpRunlog, JSON.stringify(seed, null, 2));
  const r = JSON.parse(fs.readFileSync(tmpRunlog, 'utf8'));
  const result = tickBudget(r, tokens, 'self-check');
  fs.writeFileSync(tmpRunlog, JSON.stringify(r, null, 2));
  fs.unlinkSync(tmpRunlog);

  // 4. probe self-log
  appendInbox({
    ts: new Date().toISOString(),
    type: 'self_check',
    event: 'budget-self-check',
    pid: process.pid,
    node: process.version,
    sample_tokens: tokens,
    sample_level: result.newLevel
  });

  console.log(JSON.stringify({
    ok: true,
    inbox: INBOX,
    chars_per_token: CHARS_PER_TOKEN,
    sample_tokens: tokens,
    classify: classifyLevel({ ...DEFAULT_BUDGET, current_estimate: 90000 })
  }));
  process.exit(0);
}

async function main() {
  const a = args();
  if (a.selfCheck) return selfCheck();

  ensureDirs();

  const raw     = await readStdin();
  const payload = tryParse(raw);
  const tokens  = estimateTokensFromPayload(raw, payload);

  const r = loadRunlog();
  if (!r) {
    // No runlog → no active turnkey ticket → silently noop, don't pollute inbox.
    process.exit(0);
  }

  const tickResult = tickBudget(r, tokens, a.event || 'unknown');
  try {
    saveRunlog(r);
  } catch (e) {
    logSelf(`saveRunlog error: ${e.message}`);
    process.exit(0);
  }

  // Always emit a budget_tick (small, append-only). This gives R1/R2
  // research a per-turn series without needing to diff runlog snapshots.
  appendInbox({
    ts: new Date().toISOString(),
    type: 'budget_tick',
    ticket_id: r.ticket_id || null,
    stage: r.current_stage || null,
    event: a.event || null,
    added_tokens: tokens,
    current_estimate: r.context_budget.current_estimate,
    level: r.context_budget.level
  });

  if (tickResult.warningEmitted) {
    appendInbox({
      ts: tickResult.warningEmitted.ts,
      type: 'budget_warning',
      ticket_id: r.ticket_id || null,
      stage: r.current_stage || null,
      level: tickResult.warningEmitted.level,
      ratio: tickResult.warningEmitted.ratio,
      current_estimate: tickResult.warningEmitted.current_estimate,
      msg: tickResult.warningEmitted.msg
    });
  }

  if (tickResult.migrated) {
    appendInbox({
      ts: new Date().toISOString(),
      type: 'budget_migrated',
      ticket_id: r.ticket_id || null,
      msg: 'runlog had no context_budget; default block was inserted.'
    });
  }

  process.exit(0);
}

main().catch((e) => {
  logSelf(`uncaught: ${e && e.message}`);
  process.exit(0);
});
