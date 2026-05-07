---
name: turnkey:clarify
description: Phase 1 of turnkey workflow — junior-answerable 需求澄清. 不复用 v1 的 PM 7 题问卷 (那个 junior 答不出 problem/impact/scope). 用一份 v2 自己的"junior 能答 + 答了有用"的问卷, 答不出的题 agent 帮 junior 用 grep/git log/read 文件去找答案. 触发: turnkey 主 skill 路由到 clarify, 或用户直接 /turnkey:clarify.
---

# turnkey-clarify — 阶段 1

> 目的：把 ticket text 从"模糊一段话"变成"junior 能往下走的可执行需求清单"。
> 关键：**不**问 junior 他答不出的问题（v1 PM 7 题在 v2 下不通，详见 `assumptions/baseline-v2.md` B-11）。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。**按顺序读以下文件**，不要回滚 chat scrollback 找 onboard 阶段的细节——细节已在 onboard-summary.md 里。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `ticket_id` / `raw_ticket_text` / `funnel.onboard.commands` / `context_budget.level` / `three_blindness_signals` |
| 2 | `~/.turnkey/artifacts/<ticket_id>/00-onboard-summary.md` | 上一阶段全文（特别是末尾"给 clarify 阶段的输入"段，已经为你 cherry-pick 了 3-5 条问题） |
| 3 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成；本阶段通常不存在 |

**Budget pre-flight**：进 Phase 1 前看 `runlog.context_budget.level`。≥`orange` → 回主 `turnkey/SKILL.md` Phase 0.5 处理。

## Phase 1: 装载上下文

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
TICKET_TEXT="$(jq -r .ticket_text ~/.turnkey/runlog.json)"
ONBOARD_DOC="${HOME}/.turnkey/artifacts/${TICKET_ID}/00-onboard-summary.md"
OUT="${HOME}/.turnkey/artifacts/${TICKET_ID}/01-clarify-summary.md"
```

读 onboard doc 末尾的"给 clarify 阶段的输入"段——那里已经有 onboard 阶段为你 cherry-pick 的 3-5 条必须先回答的问题。

读 `${CLAUDE_PLUGIN_ROOT}/templates/junior-questions-v0.md`（plugin 自带的问卷模板）。

## Phase 2: 问卷 — junior 能答的题

按照 `junior-questions-v0.md` 的题，**每题独立处理**：

### 处理流程

对每一道题：

1. **先尝试 agent 自答**（用 grep/find/git log/read 文件）。如果你能高置信度回答，把答案写到 `${OUT}` 的对应段，标 `agent-answered (confidence: high|medium|low)`。

2. **agent 答不了或低置信度的**，调用 AskUserQuestion 把题摆给 junior，**同时**附上：
   - 这题的"junior 怎么去找答案"提示（例：你可以 `git log -10 path/to/file` 看看）
   - 选项（如果是 yes/no 或 enum）
   - "我不知道 / 跳过" 永远是一个选项

3. **junior 选了"不知道"的**，agent **再尝试一次**自动找——找到了就 update artifact + 标 `agent-found-after-junior-skip`，找不到就标 `unresolved` 进入 deferred-decisions 列表。

### 必问的 5 类题（详细模板在 junior-questions-v0.md）

1. **本地能跑通吗** — `<本项目跑测试的命令>` 是什么？跑了多久？通过几个？
2. **改动边界范围** — 这个 ticket 涉及哪些文件 / 模块？（让 junior 用 grep + ticket 关键词回答，不让他凭记忆）
3. **谁在用这块** — 你打算改的接口/函数，谁在调？（grep 调用方）
4. **最近这块谁动过** — 涉及文件最近 3 次 commit 是谁做的？为什么？（git log）
5. **success criteria** — 在你看来，这个 ticket 做"完了"的具体表现是什么？（**这是唯一一条强制让 junior 自己答**的题——不能 agent 代答）

## Phase 3: 边界澄清（防 epic）

如果 junior 对 Q1-Q4 的回答合并起来表明这是个 epic（例：触动 ≥10 个文件 / 涉及 ≥3 个模块 / 多个 senior 是 owner），调用 AskUserQuestion：

```
你的 ticket 看起来比较大（涉及 N 个文件 / M 个模块）。
建议先切一个 sub-feature 出来走 turnkey。要怎么处理？
  (a) 切第一个 sub-feature: <agent 给一个具体建议>
  (b) 全部一起跑（warn: funnel 会很长，可能需要中途 senior async 介入）
  (c) 我先去手动拆 ticket，回头再 /turnkey
```

junior 选 (a) 时，把当前 runlog.ticket_text 改写成第一个 sub-feature 的 ticket 描述，并在 `${OUT}` 顶部 link 原始 ticket。

## Phase 4: deferred-decisions 列表

任何在 Phase 2 标 `unresolved` 的题，整理成 `${OUT}` 的 `## Deferred Decisions` 段：

```markdown
## Deferred Decisions

| # | 问题 | 为什么悬置 | 影响哪个后续阶段 | 谁能回答 |
|---|------|-----------|-----------------|---------|
| D-1 | ... | junior 不知道 + agent 也找不到 | design / develop | 此 module 的 owner: <name> |
```

→ 这个列表会在 design 阶段被 senior 待审包消费。

## Phase 5: clarify 产物

`${OUT}` 完整结构（用 `templates/clarify-summary.md` 作模板）：

```markdown
# Clarify Summary — ticket <ticket_id>

## 原始 ticket
> <逐字粘贴>

## 改写后 ticket（如果 epic 切片）
> <agent 改写的第一个 sub-feature>

## 5 类题答案
### Q1 本地能跑通吗
- 命令: <...>
- 通过/失败/跳过
- evidence: <log 摘录或截屏路径>

### Q2 改动边界
- agent 估算受影响文件: <list>
- junior 确认/补充: <...>

### Q3 谁在用这块
- agent grep 结果: <...>

### Q4 最近这块谁动过
- 最近 3 commit: <commit hash + author + msg>

### Q5 success criteria（junior 必答）
- junior 答: <...>

## Deferred Decisions
<见 Phase 4>

## 给 design 阶段的输入
- success criteria: <Q5>
- 已识别风险点 (高频 deferred 区): <...>
- senior 介入点: <Phase 4 表格里"谁能回答"列）
```

## Phase 6: stage-gate

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.clarify.status = "done";
r.funnel.clarify.ended = new Date().toISOString();
r.funnel.clarify.artifacts = [process.env.OUT];
// 检测是否需要 senior async：deferred 里有任何 D-* 标了 senior owner
const deferredHasSenior = /* parse OUT for senior tags */;
if (deferredHasSenior) r.blockers.push({ stage: "design", reason: "deferred D-* needs senior input", created: new Date().toISOString() });
r.current_stage = "design";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
'

# 写 inbox stage_exit
node -e 'fs=require("fs");fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",JSON.stringify({ts:new Date().toISOString(),type:"stage_exit",stage:"clarify",data:{artifact:process.env.OUT}})+"\n")'
```

回到主 turnkey/SKILL.md Phase 2。

## 不要做

- ❌ 不要直接复制 v1 的 7 题 PM 问卷（problem/impact/scope/desired-outcome/acceptance/risk/rollback）—— junior 答不出，详见 `design/00-scenario-lock.md` § PM 失效
- ❌ 不要让 junior 凭记忆答 Q2/Q3/Q4 —— 这是 context-blindness 的入口
- ❌ 不要把 deferred-decisions 偷偷"agent 自己拍板"—— 留着进 senior 待审包
- ❌ 不要在这阶段写任何代码 / 改任何文件（除了 artifact）

## 三盲扫描钩子

- 如果 junior 对 Q1（本地能跑通）回答"不知道"或"跑不了"→ context + permission 的强信号，在 runlog `three_blindness_scan.context_blindness_signals` 加一条
- 如果 junior 对 Q3（谁在调）的初次回答跟 agent grep 结果矛盾 → trust-blindness 信号，记录差异
- 如果 ticket 里出现非默认 convention 词（如团队自己的术语 / 内部产品名），且 junior 没主动解释 → convention 信号
