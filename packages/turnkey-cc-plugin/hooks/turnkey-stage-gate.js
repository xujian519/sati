#!/usr/bin/env node
/**
 * turnkey-stage-gate.js
 *
 * Skill-callable advisory gate. Used by SKILLs (e.g. turnkey-develop) to ask
 * "I'm in stage X — anything in the workspace I should warn the user about?"
 *
 *   node ~/.cursor/hooks/turnkey-stage-gate.js --stage develop --substep 3
 *
 * The script returns advisory JSON; it never throws and never modifies state.
 *
 * --stage <name>   canonical: which funnel stage we're in (used to look up
 *                  per-stage timing in runlog.json and apply soft cap).
 *                  must be one of: onboard|clarify|design|spec|tdd|develop|test|review|ship.
 *                  unknown values return {ok:false, error:'unknown stage'}.
 * --check <name>   DEPRECATED alias for --stage. emits a deprecation warning to
 *                  stderr but still works. will be removed in P2.
 * --substep <n>    for develop: which sub-step we're on (used for commit-deficit check)
 * --self-check     run internal sanity test, exit 0/1
 *
 * Output: single JSON line on stdout, always exit 0 unless --self-check fails.
 * The 4 advisory checks always run together; --stage just picks which stage's
 * timing entry in runlog.funnel to read for the elapsed-cap check.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

const TURNKEY_HOME = process.env.TURNKEY_HOME || path.join(os.homedir(), '.turnkey');
const RUNLOG       = path.join(TURNKEY_HOME, 'runlog.json');
const INBOX        = path.join(TURNKEY_HOME, 'inbox.jsonl');

const SOFT_CAP_MS = {
  onboard:  20 * 60 * 1000,
  clarify:  30 * 60 * 1000,
  design:   45 * 60 * 1000,
  spec:     30 * 60 * 1000,
  tdd:      20 * 60 * 1000,
  develop:  4  * 60 * 60 * 1000,
  test:     30 * 60 * 1000,
  review:   20 * 60 * 1000,
  ship:     30 * 60 * 1000
};

const VALID_STAGES = Object.keys(SOFT_CAP_MS);

function args() {
  const argv = process.argv.slice(2);
  const out = { stage: null, substep: null, selfCheck: false, deprecatedCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage' && argv[i+1]) {
      out.stage = argv[++i];
    } else if (a === '--check' && argv[i+1]) {
      // deprecated alias
      out.stage = argv[++i];
      out.deprecatedCheck = true;
    } else if (a === '--substep' && argv[i+1]) {
      out.substep = parseInt(argv[++i], 10);
    } else if (a === '--self-check') {
      out.selfCheck = true;
    }
  }
  return out;
}

function loadRunlog() {
  try { return JSON.parse(fs.readFileSync(RUNLOG, 'utf8')); }
  catch (_) { return null; }
}

function safeExec(cmd, opts) {
  try {
    return cp.execSync(cmd, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }, opts || {})).trim();
  } catch (_) { return ''; }
}

function gitCommitCountSinceISO(iso) {
  if (!iso) return null;
  const out = safeExec(`git log --since="${iso}" --oneline 2>/dev/null | wc -l`);
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

function detectRecentDestructive() {
  const reflog = safeExec('git reflog --date=iso -n 50 2>/dev/null');
  if (!reflog) return [];
  const flagged = [];
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const line of reflog.split('\n')) {
    const m = line.match(/\{([^}]+)\}/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t) || t < oneHourAgo) continue;
    if (/reset --hard|force.update|branch -D|filter-branch|push.*--force/i.test(line)) {
      flagged.push(line);
    }
  }
  return flagged;
}

function inboxSizeBytes() {
  try { return fs.statSync(INBOX).size; } catch (_) { return 0; }
}

function evaluate(stage, substep) {
  const r = loadRunlog();
  const advisories = [];

  if (!r) {
    advisories.push({ level: 'info', code: 'no-runlog', msg: 'no ~/.turnkey/runlog.json yet (first run?)' });
    return { ok: true, stage, substep, advisories };
  }
  const ticket_id = r.ticket_id || null;
  const stageInfo = (r.funnel && r.funnel[stage]) || null;

  if (stageInfo && stageInfo.started) {
    const startedMs = Date.parse(stageInfo.started);
    const elapsedMs = Date.now() - startedMs;
    const cap = SOFT_CAP_MS[stage];
    if (cap && elapsedMs > cap) {
      advisories.push({
        level: 'warn',
        code: 'soft-cap-exceeded',
        // Include the parsed start timestamp so the user can spot timezone confusion
        // (e.g. an ISO with `Z` will be interpreted as UTC; a local-clock user may
        // disagree with our "active 145min" claim).
        msg: `stage '${stage}' has been active ${Math.round(elapsedMs/60000)}min (soft cap ${Math.round(cap/60000)}min, started ${stageInfo.started}); ask user if they want to checkpoint or reduce scope.`,
        started: stageInfo.started
      });
    }
  }

  const flagged = detectRecentDestructive();
  if (flagged.length > 0) {
    advisories.push({
      level: 'alert',
      code: 'destructive-git-recent',
      msg: `git reflog shows ${flagged.length} destructive op(s) in the last hour`,
      sample: flagged.slice(0, 3)
    });
  }

  if (stage === 'develop' && Number.isFinite(substep) && substep > 0) {
    const since = stageInfo && stageInfo.started;
    const commits = gitCommitCountSinceISO(since);
    if (commits !== null && commits + 1 < substep) {
      advisories.push({
        level: 'warn',
        code: 'commit-deficit',
        msg: `at substep ${substep} but only ${commits} commits since stage start; SOP requires atomic commit per step.`
      });
    }
  }

  const sizeMB = inboxSizeBytes() / (1024 * 1024);
  if (sizeMB > 50) {
    advisories.push({
      level: 'info',
      code: 'inbox-large',
      msg: `inbox.jsonl is ${sizeMB.toFixed(1)}MB; consider archiving via 'mv inbox.jsonl inbox.archive.$(date +%s).jsonl'`
    });
  }

  return {
    ok: true,
    ticket_id,
    stage,
    substep,
    elapsed_min: stageInfo && stageInfo.started ? Math.round((Date.now() - Date.parse(stageInfo.started)) / 60000) : null,
    advisories
  };
}

function selfCheck() {
  const out = {
    ok: true,
    cmd_self_check: true,
    turnkey_home: TURNKEY_HOME,
    runlog_present: fs.existsSync(RUNLOG),
    inbox_present: fs.existsSync(INBOX),
    git_in_repo: !!safeExec('git rev-parse --is-inside-work-tree 2>/dev/null'),
    node: process.version,
    soft_caps: Object.keys(SOFT_CAP_MS)
  };
  console.log(JSON.stringify(out));
  process.exit(0);
}

function main() {
  const a = args();
  if (a.selfCheck) return selfCheck();
  if (a.deprecatedCheck) {
    console.error('[turnkey-stage-gate] DEPRECATED: --check is now --stage; will be removed in P2.');
  }
  if (!a.stage) {
    console.log(JSON.stringify({
      ok: false,
      error: 'missing --stage <name>',
      valid_stages: VALID_STAGES
    }));
    process.exit(0);
  }
  if (!VALID_STAGES.includes(a.stage)) {
    console.log(JSON.stringify({
      ok: false,
      error: `unknown stage: '${a.stage}'`,
      valid_stages: VALID_STAGES,
      hint: 'use one of valid_stages, or run with --self-check'
    }));
    process.exit(0);
  }
  const result = evaluate(a.stage, a.substep);
  console.log(JSON.stringify(result));
  process.exit(0);
}

try { main(); } catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message) }));
  process.exit(0);
}
