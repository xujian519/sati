#!/usr/bin/env node
/**
 * turnkey-substep-aggregator.js
 *
 * Stop-event hook. Auto-derives a substep count for the develop stage by
 * counting Edit/Write/MultiEdit/Bash PostToolUse records in inbox.jsonl
 * since the develop stage started, then invokes turnkey-stage-gate.js
 * with that count so the commit-deficit advisory fires WITHOUT the SKILL
 * having to opt-in via --substep <n>.
 *
 * This addresses D8 Bug 2: stage-gate's commit-deficit check was opt-in,
 * so a junior who never invokes the gate explicitly would silently pile up
 * a 200-line WIP commit. Now Stop fires this aggregator on every turn end;
 * if substep-count > commits-since-start, advisory is emitted to inbox.
 *
 * Pure Node, no deps, non-blocking on any failure.
 *
 * Usage (CC invokes via hooks.json on Stop):
 *   node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-substep-aggregator.js
 *
 *   node turnkey-substep-aggregator.js --self-check
 *
 * Output: nothing on success-quiet path; advisory line(s) appended to
 * inbox.jsonl when commit-deficit detected.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');
const readline = require('readline');

const TURNKEY_HOME = process.env.TURNKEY_HOME || path.join(os.homedir(), '.turnkey');
const RUNLOG       = path.join(TURNKEY_HOME, 'runlog.json');
const INBOX        = path.join(TURNKEY_HOME, 'inbox.jsonl');
const LOG_DIR      = path.join(TURNKEY_HOME, 'logs');
const SELF_LOG     = path.join(LOG_DIR, 'turnkey-substep-aggregator.log');
const LOCK_DIR     = path.join(TURNKEY_HOME, '.inbox.lock');

// Tools we treat as "one substep". Edit/Write/MultiEdit are file mutations;
// Bash is treated as a substep when the SKILL is mid-implementation. We do
// NOT count Read/Glob/Grep/etc — those are exploration, not increments.
const SUBSTEP_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);

// Only develop stage benefits from this — other stages don't have the
// "atomic commit per increment" SOP.
const TARGET_STAGE = 'develop';

const MAX_LOCK_WAIT_MS = 2000;

function args() {
  const argv = process.argv.slice(2);
  const out = { selfCheck: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-check') out.selfCheck = true;
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

function loadRunlog() {
  try { return JSON.parse(fs.readFileSync(RUNLOG, 'utf8')); }
  catch (_) { return null; }
}

function acquireLock() {
  const start = Date.now();
  while (Date.now() - start < MAX_LOCK_WAIT_MS) {
    try { fs.mkdirSync(LOCK_DIR); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') return false;
      const ageMs = (() => {
        try { return Date.now() - fs.statSync(LOCK_DIR).mtimeMs; }
        catch (_) { return 0; }
      })();
      if (ageMs > 5000) {
        try { fs.rmdirSync(LOCK_DIR); } catch (_) {}
        continue;
      }
      // brief spin
      const until = Date.now() + 25;
      while (Date.now() < until) { /* */ }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch (_) {}
}

function appendInbox(obj) {
  const line = JSON.stringify(obj) + '\n';
  acquireLock();
  try { fs.appendFileSync(INBOX, line); }
  finally { releaseLock(); }
}

/**
 * Detect tool name from a captured inbox record. CC's PostToolUse hook
 * payload typically has {tool_name, tool_input, tool_output} but we also
 * tolerate {name}/{tool} variants and the wrapper from turnkey-capture.js.
 */
function pickToolName(record) {
  if (!record || !record.payload) return null;
  const p = record.payload;
  return p.tool_name || p.name || p.tool || (p.tool_use && p.tool_use.name) || null;
}

/**
 * Stream-read inbox.jsonl and count Edit/Write/MultiEdit/Bash PostToolUse
 * records whose ts >= sinceISO.
 *
 * We use line-streaming so a 50MB inbox doesn't blow up memory.
 */
async function countSubstepsSince(sinceISO) {
  if (!fs.existsSync(INBOX)) return 0;
  const sinceMs = Date.parse(sinceISO);
  if (!Number.isFinite(sinceMs)) return 0;

  return new Promise((resolve) => {
    let count = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(INBOX, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
    rl.on('line', (line) => {
      if (!line) return;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { return; }
      if (!rec || rec.event !== 'PostToolUse') return;
      const ts = rec.ts ? Date.parse(rec.ts) : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) return;
      const tool = pickToolName(rec);
      if (tool && SUBSTEP_TOOLS.has(tool)) count++;
    });
    rl.on('close', () => resolve(count));
    rl.on('error', () => resolve(count));
  });
}

function safeExec(cmd, opts) {
  try {
    return cp.execSync(cmd, Object.assign({
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    }, opts || {})).trim();
  } catch (_) { return ''; }
}

function callStageGate(substep) {
  const script = path.join(__dirname, 'turnkey-stage-gate.js');
  if (!fs.existsSync(script)) {
    logSelf(`stage-gate script missing at ${script}`);
    return null;
  }
  const out = safeExec(`node "${script}" --stage ${TARGET_STAGE} --substep ${substep}`, { timeout: 5000 });
  try { return JSON.parse(out); } catch (_) { return null; }
}

async function main() {
  ensureDirs();
  const r = loadRunlog();
  if (!r) {
    // No active turnkey ticket — silent noop.
    process.exit(0);
  }
  if (r.current_stage !== TARGET_STAGE) {
    // Only run for develop stage.
    process.exit(0);
  }
  const stageInfo = (r.funnel && r.funnel[TARGET_STAGE]) || null;
  const startedISO = stageInfo && stageInfo.started;
  if (!startedISO) {
    process.exit(0);
  }

  const substep = await countSubstepsSince(startedISO);
  if (substep <= 0) {
    process.exit(0);
  }

  const gateResult = callStageGate(substep);
  if (!gateResult || !Array.isArray(gateResult.advisories)) {
    process.exit(0);
  }

  // Forward only the commit-deficit advisory to inbox. Other advisories
  // (soft-cap, destructive) are already surfaced when SKILL invokes the
  // gate manually; we don't want to double-emit on every Stop.
  const deficit = gateResult.advisories.find((a) => a && a.code === 'commit-deficit');
  if (deficit) {
    appendInbox({
      ts: new Date().toISOString(),
      type: 'auto_substep_advisory',
      ticket_id: r.ticket_id || null,
      stage: TARGET_STAGE,
      derived_substep: substep,
      advisory: deficit,
      msg: 'auto-derived substep count from inbox PostToolUse events'
    });
  }
  process.exit(0);
}

async function selfCheck() {
  ensureDirs();
  const out = {
    ok: true,
    cmd_self_check: true,
    turnkey_home: TURNKEY_HOME,
    inbox_present: fs.existsSync(INBOX),
    runlog_present: fs.existsSync(RUNLOG),
    target_stage: TARGET_STAGE,
    substep_tools: [...SUBSTEP_TOOLS],
    node: process.version
  };
  // Probe: count substeps in last 24h to make sure stream-read works.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  out.probe_count_last_24h = await countSubstepsSince(dayAgo);
  console.log(JSON.stringify(out));
  process.exit(0);
}

(async () => {
  try {
    const a = args();
    if (a.selfCheck) return await selfCheck();
    await main();
  } catch (e) {
    logSelf(`uncaught: ${e && e.message}`);
    process.exit(0);
  }
})();
