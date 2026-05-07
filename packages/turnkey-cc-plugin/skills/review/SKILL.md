---
name: turnkey:review
description: Phase 7 of turnkey — 自审 + PR 准备. 跑机器自审 (diff size / convention check / 与 design doc 一致性), 生成 PR description (含 design summary / test report / 已知 deferred / risk / rollback), 等 senior async review (如果 design 阶段有 senior packet). 不替代 senior review (NG-03), 目标是减少 senior 喷点. 触发: turnkey 主 skill 路由到 review.
---

# turnkey-review — 阶段 7

> 目的：让 PR 在到 senior 之前**已经预演了 senior 会看的所有维度**。这是 v2 funnel 的 review-gate（`design/00-scenario-lock.md` 必填 3 Stage 3）。
> 不**替代** senior review（违反 NG-03）。目标是**减少** senior 要喷的点。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。Review 是 last-pass，需要**最完整的产物视图**——这阶段读得最全，**所以最容易撞 budget 上限**，必须严格按 artifact 读、不要回滚 chat scrollback。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | 全 funnel 状态 / `deferred_decisions` / `three_blindness_signals` / `context_budget.level` |
| 2 | `~/.turnkey/artifacts/<ticket_id>/02-design-doc.md` | "实际做的"对照"原计划"——senior 必看 |
| 3 | (optional) `~/.turnkey/artifacts/<ticket_id>/02-senior-async-review.md` | 如有，需要 verify senior 是否回复 |
| 4 | (optional) `~/.turnkey/artifacts/<ticket_id>/03-spec.md` | 契约一致性检查 |
| 5 | (optional) `~/.turnkey/artifacts/<ticket_id>/04-tdd-plan.md` | 测试覆盖 vs 计划 |
| 6 | `~/.turnkey/artifacts/<ticket_id>/05-develop-log.md` | scope-creep / pre-existing-failures / trust-check |
| 7 | `~/.turnkey/artifacts/<ticket_id>/06-test-report.md` | CI 模拟结果 |
| 8 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成 |

**Budget pre-flight**：review 阶段读最多的 artifact。进 Phase 1 前**强制**重看一次 `runlog.context_budget.level`：
- `green` / `yellow` → 继续
- `orange` / `red` → **不要硬读 7 份 artifact**。回主 `turnkey/SKILL.md` Phase 0.5 处理；考虑切到 fresh session resume。

## Phase 1: 装载所有上游产物

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
ART="${HOME}/.turnkey/artifacts/${TICKET_ID}"
DESIGN="${ART}/02-design-doc.md"
SENIOR_PKG="${ART}/02-senior-async-review.md"  # 可能不存在
SPEC="${ART}/03-spec.md"                       # 可能不存在
TDD="${ART}/04-tdd-plan.md"                    # 可能不存在
DEV_LOG="${ART}/05-develop-log.md"
TEST="${ART}/06-test-report.md"
OUT="${ART}/07-pr-package.md"
```

## Phase 2: 自审 checklist（机器跑）

按 `templates/PR-checklist.md` 逐条检查，每条 ✅ / ⚠️ / ❌ 标记 + evidence：

### 2.1 Diff health
- diff size：`git diff <base> HEAD --shortstat` —— 超过 ±500 行 / >20 文件触发 warn
- 是否含敏感信息：grep diff 中的 password / secret / api_key / token
- 是否含 debug 残留：grep `console.log` / `print(` / `debugger;` / `binding.pry` / `dbg!`
- 是否含 TODO/FIXME 新增：警示而不阻塞
- 是否触动了不该触动的目录：基于 design doc §1 范围判定

### 2.2 与 design / spec 一致性
- design Option X 的所有改动点都在 diff 里？（未实现的部分应在 PR description 里 explicit defer）
- spec §2 每个接口的签名跟实际一致？
- 没有"design 没说但实际改了"的内容（scope creep）

### 2.3 Convention compliance
- commit message 符合 onboard 抓的 convention 吗（conventional commits？）
- 测试文件命名 / 位置符合 convention 吗
- import 顺序 / 引号 / 行长度 符合 lint 配置吗（`turnkey-test` 阶段已经跑过 lint，这里 cross-check）

### 2.4 Test coverage（cross-check `${TEST}`）
- block-ship coverage gaps 都补了？
- nice-to-have deferred 列表会在 PR description 里 explicit 吗

### 2.5 Trust-blindness final check（**关键**）
- develop 阶段的 trust-check 汇总里所有"low confidence"的 step，最后跑了一次真实 demo 验证吗？
- 涉及第三方 API / 库的部分，调一次真实 endpoint（如可能）确认

### 2.6 Senior async review status
- 如果有 `${SENIOR_PKG}`，senior 回复了吗？
  - ✅ 回复 + 通过 → 继续
  - ⚠️ 回复 + 有 concern → 停止，记到 blockers，回到对应 stage
  - ❌ 没回复 + 等待 ≥24h → AskUserQuestion 让 junior 决定：继续 push PR 还是再等

## Phase 3: PR description 草稿

写 `${OUT}`（这就是 PR description 的内容，junior 直接 copy 到 GitHub PR）：

```markdown
# PR — <ticket_id>: <one-line summary>

## What
<2-3 行 — 改了什么>

## Why
<2-3 行 — ticket 来源 + business reason if known>

## How
<concise version of design Option X>

## Test plan
- [x] <test point 1> — passed locally
- [x] <test point 2> — passed locally
- [ ] <test point 3> — deferred to follow-up PR (see Deferred)
- CI 应该 pass: lint / type / unit / integration

## Risks & rollback
- risk 1: ... → mitigated by ...
- rollback: revert this PR + <any data migration concern>

## Deferred / not in this PR (explicit non-goals)
- nice-to-have test: <list>
- pre-existing failures untouched: <list>
- scope-creep ideas surfaced: <list — for future tickets>

## Senior async review
<paste link or status of senior_pkg if exists>

## Files changed (high-level groupings)
- <module 1>: <what>
- <module 2>: <what>

---

🤖 Generated with [turnkey-prototype](_drift/turnkey-prototype/)
```

## Phase 4: 让 junior 真的 push（**或** 不 push）

调用 AskUserQuestion：

```
PR package 已经准备好在 ~/.turnkey/artifacts/<ticket_id>/07-pr-package.md
怎么走下一步？
  (a) 我现在就 git push + 自己手动开 PR（推荐 — 你保留控制感）
  (b) agent 帮我 git push origin <branch> （不开 PR，留给你手动开）
  (c) agent 帮我 push + 用 gh CLI 开 PR (需要你机器装了 gh + 已登录)
  (d) 先不 push — 让我自己再看一遍 artifact
```

如果选 (b) 或 (c)，**push 之前**展示 `git diff <base> HEAD --stat` 给 junior 二次确认。

如果用 `gh`：
```bash
gh pr create --title "<from PR title line>" --body "$(cat ${OUT})" --draft
```
（默认 draft，让 junior 自己 mark ready for review）

## Phase 5: 推进

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.review.status = "done";
r.funnel.review.ended = new Date().toISOString();
r.funnel.review.artifacts = [process.env.OUT];
r.funnel.review.pr_url = process.env.PR_URL || null;  // 如果开了
r.current_stage = "ship";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",
  JSON.stringify({ts:new Date().toISOString(),type:"stage_exit",stage:"review"})+"\n");
'
```

## 不要做

- ❌ 不要在 PR description 里写 "AI generated"／"Claude wrote this" 类标签（合规风险——除非项目本身允许；目前在产物末尾留了一行 turnkey attribution，junior 可自删）
- ❌ 不要 force-push（除非 junior 显式要求 + 二次 confirm）
- ❌ 不要把 senior review 状态隐藏（"等 senior 回" 必须出现在 PR description 或 blocker 列表里，对自己诚实）
- ❌ 不要替 junior open PR 然后 mark "ready for review"（junior 必须自己点那个按钮，给他**一次最后的反悔机会**）

## 三盲扫描钩子

- 如果 junior 选 (a/b/c) 时没有看 §7 PR description——所有三盲都没机会被他自己捕捉
- 如果 senior async 已回复 "concern" 但 junior 想跳过 → 强 trust-blindness alert，**强制** AskUserQuestion 二次确认
- 如果 PR description 跟 design doc 对不上 → context-blindness 风险（junior 没意识到方案中途变了）
