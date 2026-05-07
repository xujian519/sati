---
name: turnkey:develop
description: Phase 5 of turnkey — 实现. 按 design / spec / tdd 的 step list 分块写代码, 每块跑现有 lint + test, 每块写 atomic commit. 关键: 主动对 trust-blindness 高风险区做 verification (二次跑 / 看真实输出 / 对比文档). 不一次性写一大坨. 触发: turnkey 主 skill 路由到 develop.
---

# turnkey-develop — 阶段 5

> 目的：把 design / spec / tdd 的方案落实到代码，**每块小、每块测、每块 commit**。
> Junior 失败模式：会"AI 一口气写 500 行 → 跑不起来 → 不知道哪里坏"。这阶段的 SOP 是**强制小步快跑**。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。**按顺序读以下文件**。develop 是最长的阶段，最容易撞 budget 上限——严格按这里读，不要回滚 chat scrollback 重读 design / spec。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `funnel.onboard.commands.{lint,test}` / `funnel.design.chosen_option` / `context_budget.level` |
| 2 | `~/.turnkey/artifacts/<ticket_id>/02-design-doc.md` | §3 选定 Option / §6 risks（每个 step 的 trust-check 锚点） |
| 3 | (optional) `~/.turnkey/artifacts/<ticket_id>/04-tdd-plan.md` | tdd 阶段的 micro-step 列表（如有） |
| 4 | (optional) `~/.turnkey/artifacts/<ticket_id>/03-spec.md` | 接口契约（如有） |
| 5 | `~/.turnkey/artifacts/<ticket_id>/05-develop-log.md` (本阶段产物，可能已存在/部分写入) | step list 进度 / 已 commit hash |
| 6 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成 |

**Budget pre-flight**：develop 阶段 budget 涨幅最快。**每跑完 3 个 step 就重看一次** `runlog.context_budget.level`：
- `green` / `yellow` → 继续
- `orange` → 暂停，让 junior 决定是否压缩 + 切到新 session resume
- `red` → 强制停，回主 `turnkey/SKILL.md` Phase 0.5 处理

## Phase 1: 装载上下文 + 切 working branch

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
DESIGN="${HOME}/.turnkey/artifacts/${TICKET_ID}/02-design-doc.md"
SPEC="${HOME}/.turnkey/artifacts/${TICKET_ID}/03-spec.md"      # 可能不存在
TDD="${HOME}/.turnkey/artifacts/${TICKET_ID}/04-tdd-plan.md"   # 可能不存在
LOG="${HOME}/.turnkey/artifacts/${TICKET_ID}/05-develop-log.md"

# 切 branch（如果当前在 main / master）
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${CURRENT_BRANCH}" == "main" || "${CURRENT_BRANCH}" == "master" ]]; then
  # AskUserQuestion: branch 命名 — 给 junior 3 个建议
  # e.g. feat/<ticket_id>-<slug> / junior-name/<slug> / 直接用 cursor 的 branch
  git checkout -b "feat/turnkey-${TICKET_ID}"
fi
```

## Phase 2: 读 step list

如果走了 tdd → 从 `${TDD}` 抽 micro-step 列表。
如果没走 tdd → 从 `${DESIGN}` Option X 自己拆出 ≤8 个 micro-step。

把 step list 写到 `${LOG}` 顶部，每个 step 带 checkbox。

## Phase 3: 逐个 step 实现 — **严格 SOP**

对每个 step（**循环**）：

### 3.1 announce step

print: "STEP <i>/<N>: <description>"

### 3.2 写代码

- 找到要改 / 要创建的文件
- 写最小改动让该 step 的 test 转绿（如果是 tdd 模式）
  - 或：让该 step 的具体 acceptance 满足（如果不是 tdd 模式）
- **不要**顺手"重构无关代码"——记下来到 `${LOG}` 的 §scope-creep-temptations 段，等 review 阶段处理
- **不要**一次写超过 ~80 行——超出就拆 sub-step

### 3.3 跑 lint + test

```bash
# 从 onboard / clarify 拿到的命令
LINT_CMD="$(jq -r '.funnel.onboard.commands.lint // ""' ~/.turnkey/runlog.json)"
TEST_CMD="$(jq -r '.funnel.onboard.commands.test // ""' ~/.turnkey/runlog.json)"

[[ -n "${LINT_CMD}" ]] && eval "${LINT_CMD}" 2>&1 | tail -30
[[ -n "${TEST_CMD}" ]] && eval "${TEST_CMD}" 2>&1 | tail -30
```

如果 lint / test 失败：
- 把失败原因贴进 `${LOG}` step 行下面
- **修**——但**只**修这个 step 引入的失败，不去修无关的失败（无关失败记进 `${LOG}` §pre-existing-failures）

### 3.4 trust-blindness 二次校验（**强制**）

针对本 step 用到的关键 API / 库，做以下任一：
- 跑一次最小 demo 看真实返回值（不只是 type check）
- read 库的 source 或 doc 一段，confirm 用法没有 hallucinate
- 跟 codebase 已有的同类用法 grep 对比

把校验记录写进 `${LOG}` step 行下面的 `## trust-check`。**这一步不能跳**。

### 3.5 atomic commit

```bash
git add -A
git status                                       # show what's staged
git diff --cached --stat                         # show stats
git commit -m "<step description> (turnkey ${TICKET_ID})"
```

写 `${LOG}` 这个 step 的 checkbox 打勾 + commit hash。

### 3.6 stage gate（轻量）

```bash
node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-stage-gate.js --stage develop --substep $i
```

如果 gate 报告"已超时 / commit 个数异常 / 出现破坏性变更" → 停下来 AskUserQuestion 跟 junior 确认。

> **自动后台守护**: 自 v0.1.0-cc Bug-2 修复起,`Stop` hook 会调用 `turnkey-substep-aggregator.js`,自动从 `inbox.jsonl` 数 develop 阶段以来 Edit/Write/MultiEdit/Bash 工具调用次数,推算 substep 计数,并自动调 stage-gate 触发 commit-deficit 检查。如果 inbox 出现 `type: auto_substep_advisory` 行,说明你已积累了 substep 但缺对应 atomic commit,在下一次回应前要主动 review 并 commit,或显式跟 junior 确认是否要合并。手动 substep 调用仍是首选(给 gate 准确数字),自动机制只是兜底。

## Phase 4: develop 阶段总结

step list 全部勾完后，写 `${LOG}` 的 §summary：

```markdown
## Summary
- step 完成: N/N
- atomic commits: <list of hashes>
- 触动文件: <list>
- 新增 LoC / 删除 LoC
- 残留 scope-creep-temptations: <list — review 阶段决定要不要做>
- 残留 pre-existing-failures: <list — review 阶段决定要不要 issue>

## Trust-check 汇总
- step 1: <做了什么校验, 结果>
- step 2: ...
```

## Phase 5: 推进

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.develop.status = "done";
r.funnel.develop.ended = new Date().toISOString();
r.funnel.develop.artifacts = [process.env.LOG];
r.current_stage = "test";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",
  JSON.stringify({ts:new Date().toISOString(),type:"stage_exit",stage:"develop"})+"\n");
'
```

## 不要做

- ❌ 不要一次写超过 80 行（如果 LLM 倾向于一次给 500 行 — 截断）
- ❌ 不要跳过 trust-check（这是 v2 跟 v1 最大的差异之一 — junior 没有 senior 的"嗅觉"）
- ❌ 不要在 develop 阶段做"顺手重构"（写在 scope-creep 段里，让 review 阶段处理）
- ❌ 不要在 commit message 里写 "WIP / fixes / stuff" — 必须有 step description
- ❌ 不要 force push（force push 在这阶段属于 destructive，要二次确认）

## 三盲扫描钩子

- 每个 step 的 trust-check 段都是 trust-blindness signal 的直接采集
- 如果改了某文件但没看它的 import 是否被外部 consumer 用——context-blindness signal
- 如果 commit message 跟项目的 conventional commit 习惯不符——convention-blindness signal
