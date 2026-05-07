---
name: turnkey:ship
description: Phase 8 of turnkey — 部署上线 + 7 天 regression 监控. 不自动部署 (NG-05 + 安全). 检测项目部署模式 (CI auto-merge / manual / fly/render/vercel/k8s/...), 生成 deploy checklist, 在 PR merge 后启动 7d 软监控 (定时 reminder + 关键 metric 提示). 收尾时把 8 阶段 process funnel 导出为 5 阶段 outcome funnel 初始填表 (给 R1 研究用). 触发: turnkey 主 skill 路由到 ship.
---

# turnkey-ship — 阶段 8

> 目的：把 PR 真的 merge 到 main 并上线，**不**自动 push deploy（绝大多数公司有合规约束 + junior 没权限）。
> 这阶段产出的是**部署清单 + 7 天 regression watch 触发**——junior 跟着清单做，agent 协助校验。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。Ship 阶段读得很少——主要靠 PR package + runlog。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `funnel.review.pr_url` / `context_budget.level` / 全 funnel 摘要 |
| 2 | `~/.turnkey/artifacts/<ticket_id>/07-pr-package.md` | merge 后 closeout 的来源 |
| 3 | (optional) `~/.turnkey/artifacts/<ticket_id>/06-test-report.md` | 如果需要重新跑 smoke test |
| 4 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成 |

**Budget pre-flight**：进 Phase 1 前看 `runlog.context_budget.level`。`red` → 不要硬启动 7 天 regression watch loop（会持续吃 token），先 closeout + 让 junior 在新 session 跟进 watch。

## Phase 1: 装载上下文

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
ART="${HOME}/.turnkey/artifacts/${TICKET_ID}"
PR_PKG="${ART}/07-pr-package.md"
PR_URL="$(jq -r '.funnel.review.pr_url // ""' ~/.turnkey/runlog.json)"
OUT="${ART}/08-ship-checklist.md"
```

## Phase 2: 检测项目部署模式

```bash
# CI 平台
[[ -d .github/workflows ]] && grep -l "deploy\|publish\|release" .github/workflows/*.yml 2>/dev/null
[[ -f .gitlab-ci.yml ]] && grep -i "deploy" .gitlab-ci.yml
[[ -f Jenkinsfile ]] && grep -i "deploy" Jenkinsfile

# Deploy 平台 hint
[[ -f fly.toml ]]            && echo "PLATFORM: fly.io"
[[ -f render.yaml ]]         && echo "PLATFORM: render"
[[ -f vercel.json ]]         && echo "PLATFORM: vercel"
[[ -f netlify.toml ]]        && echo "PLATFORM: netlify"
[[ -f Procfile ]]            && echo "PLATFORM: heroku-style"
[[ -d k8s ]] && echo "PLATFORM: kubernetes"
[[ -f docker-compose.prod.yml ]] && echo "PLATFORM: docker-compose"

# Auto-merge?
gh pr view "${PR_URL}" --json autoMergeRequest 2>/dev/null
```

把识别结果写到 `${OUT}` 的 §部署模式 段。

## Phase 3: 部署 checklist 生成

按照检测到的模式，**为这个 PR 量身定制** checklist。例：

```markdown
# Ship Checklist — ticket <ticket_id>

## 部署模式（识别）
- CI: GitHub Actions / .github/workflows/deploy.yml
- 平台: Fly.io
- Auto-deploy: ✅ 在 main 上 push 自动 deploy

## Pre-merge
- [ ] PR description 已更新（test 阶段已确认）
- [ ] CI 全绿（最新一次 run: <link>）
- [ ] senior 已 approve（reviewer: <name>）
- [ ] 没有未解决的 review comment
- [ ] 跟 main 是 up-to-date 的（不需要 rebase）

## Merge 动作
- [ ] 选 merge strategy: squash / merge / rebase （依据 onboard 抓的 convention）
- [ ] merge 后 branch 自动删？默认是
- [ ] merge commit message 跟 PR title 一致

## Post-merge: 上线
（基于平台）
- [ ] CI deploy job 触发了（GitHub Actions 显示 "deploy" workflow running）
- [ ] deploy 完成后看 health check （`curl https://<prod>/healthz` 或类似）
- [ ] 看错误日志 5 分钟（log 平台 link）

## Post-deploy: smoke test
- [ ] 手动跑 success criteria 里的 happy path（来自 clarify Q5）
- [ ] 看 metrics dashboard 异常（错误率 / 延迟 / 流量）

## 7 天 regression watch（**软监控**）
- 监控开始: <now>
- 监控结束: <now + 7d>
- agent 会在 day 1 / 3 / 7 提醒 junior 检查：
  - 跟本 ticket 相关的 error / log / metric 异常
  - 是否有 hotfix 提交触动本 ticket 改过的文件
  - 是否被 revert
```

## Phase 4: junior 拍板

调用 AskUserQuestion 把 checklist 摆出来：

```
ship checklist 已经生成在 ~/.turnkey/artifacts/<ticket_id>/08-ship-checklist.md
我现在能帮你做的：
  (a) 显示当前 PR 状态（CI / approval / mergeable）— 通过 gh CLI
  (b) 跑 health check on <detected url> — 仅你 confirm 后
  (c) 帮你写 7 天 watch 的本地 cron / launchd reminder
  (d) 啥也不做 — 我自己跟着 checklist 走
```

**绝对不**自动 merge，不自动 deploy。

## Phase 5: 7 天 regression watch（软监控）

如果 junior 选了 (c)，写一个 launchd plist（macOS）或 systemd timer（linux）或 cron line：

```bash
# macOS launchd 例
cat > ~/Library/LaunchAgents/com.turnkey.watch.${TICKET_ID}.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
...
<key>StartInterval</key><integer>86400</integer>  <!-- daily -->
...
EOF
launchctl load ~/Library/LaunchAgents/com.turnkey.watch.${TICKET_ID}.plist
```

reminder 触发时跑一个 node 脚本：
- 读 `~/.turnkey/runlog.json` 找本 ticket
- check git log 是否有 revert / fix-up 触动本 ticket 文件
- 写一条 `inbox.jsonl` `regression_watch` 行
- 弹 osascript notification（macOS）or notify-send（linux）

day 7 自动 expire 并写 `regression_watch_complete` 行。

## Phase 6: closeout — 把 process funnel 导出为 outcome funnel

`design/00-scenario-lock.md` 必填 3 的 5 阶段 outcome funnel 是给 operator R1 研究用的衡量。这阶段把本次 ticket 的 8 阶段 process funnel 数据**导出**为 outcome funnel 的初始填表：

```bash
OUTCOME="${ART}/08-outcome-funnel.json"
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(`${process.env.HOME}/.turnkey/runlog.json`, "utf8"));
const outcome = {
  ticket_id: r.ticket_id,
  outcome_funnel: {
    stage_1_local_works:  { status: r.funnel.test.status === "done" ? "pass" : "unknown", evidence: r.funnel.test.artifacts },
    stage_2_ci_passes:    { status: "pending", evidence: [r.funnel.review.pr_url] },
    stage_3_senior_review:{ status: "pending", evidence: [r.funnel.review.pr_url] },
    stage_4_merge:        { status: "pending" },
    stage_5_no_regression_7d: { status: "watching", started: new Date().toISOString() }
  }
};
fs.writeFileSync(process.env.OUTCOME, JSON.stringify(outcome, null, 2));
'
```

## Phase 7: 推进 + funnel done

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.ship.status = "done";
r.funnel.ship.ended = new Date().toISOString();
r.funnel.ship.artifacts = [process.env.OUT, process.env.OUTCOME];
r.current_stage = "complete";
r.completed_at = new Date().toISOString();
fs.writeFileSync(path, JSON.stringify(r, null, 2));
fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",
  JSON.stringify({ts:new Date().toISOString(),type:"funnel_complete",stage:"ship",data:{ticket_id:r.ticket_id,outcome:process.env.OUTCOME}})+"\n");
'
```

print closeout：

```
turnkey ticket <ticket_id> COMPLETE
process funnel: onboard ✓ clarify ✓ design ✓ [spec ✓|skipped] [tdd ✓|skipped] develop ✓ test ✓ review ✓ ship ✓
artifacts: ~/.turnkey/artifacts/<ticket_id>/
PR: <url>
outcome funnel: ~/.turnkey/artifacts/<ticket_id>/08-outcome-funnel.json
7d regression watch: started, ends <date>

if you want to start a new ticket: /turnkey "<new ticket text>"
```

## 不要做

- ❌ **不要**自动 merge / 自动 deploy / 自动 push 任何 destructive 动作
- ❌ 不要在 7 天内"假装观察到 regression"——只 surface 真实的 git/log 信号
- ❌ 不要在 closeout 后改 runlog（archive it 用 ticket_id 重命名）
- ❌ 不要假装能 access junior 没给你的 deploy 平台（"我看了 metrics" 必须有 evidence）

## 三盲扫描钩子

- 如果 junior 在 deploy 后看到 metric 异常但说"应该跟我没关系"——context-blindness signal（不知道自己改了什么），强制 AskUserQuestion 让他 grep merge commit
- 如果 7 天 watch 期间出现 hotfix 触动了本 ticket 改过的文件——这是**最关键的 outcome funnel signal**，写进 outcome funnel `stage_5_no_regression_7d.status = "fail"`
