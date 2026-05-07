#!/usr/bin/env node
/**
 * turnkey-bootstrap.js — Phase 0 single-call bootstrap
 *
 * 解决:start/SKILL.md Phase 0 原本展示 4 个独立 ```bash 块 (mkdir / hash /
 * resume-check / write-runlog),LLM 倾向并行发 4 个 Bash tool_use。在某些
 * proxy 链路下 (e.g. anthropic-native ↔ openai 双重转换的 OpenRouter),
 * multi-tool streaming 会丢字段(详见 ticket fbbf49c3a154)。此 hook 把全
 * 部 bootstrap 收敛为一次 node 调用。
 *
 * 使用:
 *   node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-bootstrap.js "<ticket text>"
 *   # 或 env: TURNKEY_TICKET_TEXT="..." node turnkey-bootstrap.js
 *
 * 输出 (stdout, JSON 单行):
 *   {"ticket_id":"abc123def456","artifact_dir":"/Users/.../artifacts/abc123def456","action":"new"|"resume","runlog":"/Users/.../runlog.json","archived":"...|null"}
 *
 * 退出码:0 成功,非 0 失败 (stderr 含原因)。
 *
 * 注意:仍然遵守 TURNKEY_HOME env 隔离 (默认 ~/.turnkey)。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function fail(msg, code = 1) {
  process.stderr.write(`turnkey-bootstrap: ${msg}\n`);
  process.exit(code);
}

function main() {
  const ticketText = process.argv[2] || process.env.TURNKEY_TICKET_TEXT || '';
  if (!ticketText.trim()) {
    fail('missing ticket text (pass as argv[1] or TURNKEY_TICKET_TEXT env)');
  }

  const home = process.env.TURNKEY_HOME || path.join(os.homedir(), '.turnkey');
  const artifactsRoot = path.join(home, 'artifacts');
  const logsRoot = path.join(home, 'logs');
  const runlogPath = path.join(home, 'runlog.json');

  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.mkdirSync(logsRoot, { recursive: true });

  const ticketId = crypto.createHash('sha256').update(ticketText).digest('hex').slice(0, 12);
  const artifactDir = path.join(artifactsRoot, ticketId);
  fs.mkdirSync(artifactDir, { recursive: true });

  let action = 'new';
  let archived = null;

  if (fs.existsSync(runlogPath)) {
    let existingId = null;
    try {
      existingId = JSON.parse(fs.readFileSync(runlogPath, 'utf8')).ticket_id;
    } catch (e) {
      // corrupt runlog → archive defensively
    }
    if (existingId === ticketId) {
      action = 'resume';
    } else {
      const archiveTo = path.join(home, `runlog.${existingId || 'corrupt-' + Date.now()}.json`);
      fs.renameSync(runlogPath, archiveTo);
      archived = archiveTo;
    }
  }

  if (action === 'new') {
    // template path — try plugin's templates/runlog.template.json (relative to this script)
    const templateCandidates = [
      path.join(__dirname, '..', 'templates', 'runlog.template.json'),
      // fallback for when CLAUDE_PLUGIN_ROOT layout drifts
      path.join(process.env.CLAUDE_PLUGIN_ROOT || '', 'templates', 'runlog.template.json'),
    ];
    let template = null;
    for (const tp of templateCandidates) {
      if (tp && fs.existsSync(tp)) {
        try {
          template = JSON.parse(fs.readFileSync(tp, 'utf8'));
          break;
        } catch (e) {
          /* try next */
        }
      }
    }
    if (!template) {
      // hard fallback minimal template (keeps bootstrap working even if template file is missing)
      template = {
        $schema_version: '0.1.0-prototype',
        current_stage: 'onboard',
        stages_completed: [],
        skipped_stages: [],
        funnel: {
          onboard:  { status: 'in_progress', started: null, ended: null, artifacts: [] },
          clarify:  { status: 'pending', started: null, ended: null, artifacts: [] },
          design:   { status: 'pending', started: null, ended: null, artifacts: [], chosen_option: null, needs_senior_review: false },
          spec:     { status: 'pending', started: null, ended: null, artifacts: [] },
          tdd:      { status: 'pending', started: null, ended: null, artifacts: [] },
          develop:  { status: 'pending', started: null, ended: null, artifacts: [], commits: [] },
          test:     { status: 'pending', started: null, ended: null, artifacts: [] },
          review:   { status: 'pending', started: null, ended: null, artifacts: [], pr_url: null },
          ship:     { status: 'pending', started: null, ended: null, artifacts: [] },
        },
        blockers: [],
        deferred_decisions: [],
        three_blindness_signals: { convention_blindness: [], trust_blindness: [], context_blindness: [] },
        context_budget: { model: 'unknown', model_window: 200000, yellow_pct: 0.40, orange_pct: 0.60, red_pct: 0.80, current_estimate: 0, level: 'green', per_stage: {}, warnings: [] },
      };
    }
    const now = new Date().toISOString();
    template.ticket_id = ticketId;
    template.raw_ticket_text = ticketText;
    template.started_at = now;
    if (template.funnel && template.funnel.onboard) {
      template.funnel.onboard.started = now;
      template.funnel.onboard.status = 'in_progress';
    }
    fs.writeFileSync(runlogPath, JSON.stringify(template, null, 2));
  }

  // structured stdout — single JSON line so SKILL can parse with jq/node -p
  process.stdout.write(JSON.stringify({
    ticket_id: ticketId,
    artifact_dir: artifactDir,
    action,
    runlog: runlogPath,
    archived,
    home,
  }) + '\n');
}

try {
  main();
} catch (e) {
  fail(`uncaught: ${e && e.stack ? e.stack : e}`, 2);
}
