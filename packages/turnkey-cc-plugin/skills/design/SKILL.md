---
name: turnkey:design
description: Phase 2 of turnkey — 方案设计 + senior 待审包. 产出 design-doc.md (技术方案 + 1-3 个 alternatives + trade-off + risk + rollback). 关键产物是"senior 异步审核包" — 一个 senior 5 分钟能扫完决策点的紧凑版本. 触发: turnkey 主 skill 路由到 design.
---

# turnkey-design — 阶段 2

> 目的：把 clarify 阶段的"已澄清需求"转成"可被 senior 5 分钟审过的方案 + 可被 develop 阶段照着干的边界"。
> 关键：**不替 junior 拍板技术选型**。给 1-3 个 alternative + trade-off + 自己的推荐 + AskUserQuestion 让 junior 选。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。**按顺序读以下文件**。onboard 的细节去 00-onboard-summary.md 找，不要回滚 chat scrollback。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `current_stage` / `blockers` / `deferred_decisions` / `context_budget.level` |
| 2 | `~/.turnkey/artifacts/<ticket_id>/01-clarify-summary.md` | 上一阶段全文（success criteria / 改动边界 / deferred decisions） |
| 3 | `~/.turnkey/artifacts/<ticket_id>/00-onboard-summary.md` | 找：技术栈 / 模块切分 / convention signals |
| 4 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成 |

**Budget pre-flight**：进 Phase 1 前看 `runlog.context_budget.level`。≥`orange` → 回主 `turnkey/SKILL.md` Phase 0.5 处理。

## Phase 1: 装载上下文

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
ONBOARD="${HOME}/.turnkey/artifacts/${TICKET_ID}/00-onboard-summary.md"
CLARIFY="${HOME}/.turnkey/artifacts/${TICKET_ID}/01-clarify-summary.md"
OUT="${HOME}/.turnkey/artifacts/${TICKET_ID}/02-design-doc.md"
```

读 onboard 找：技术栈 / 模块切分 / convention signals。
读 clarify 找：success criteria / 改动边界 / deferred decisions。

## Phase 2: 方案草稿（agent 主笔，junior 决策）

按 `templates/design-doc.md` 的结构写 `${OUT}`：

```markdown
# Design Doc — ticket <ticket_id>

## 1. 问题陈述（来自 clarify）
- ticket: ...
- success criteria: ...

## 2. 现状（来自 onboard）
- 涉及模块: ...
- 关键 entry point: ...
- 相关最近变更: ...

## 3. 方案选项（agent 提供 1-3 个 alternative）
### Option A: <名字>
- 大致改动: ...
- 优点: ...
- 缺点: ...
- 时间预估（agent 凭经验): ...
- 信任度（这条方案 agent 有多高把握确实可行）: high/medium/low

### Option B: ...
### Option C: ...

## 4. agent 推荐 + 理由
推荐 Option <X>，理由：
- ...
- ...

## 5. 待 junior 决策的 trade-off（用 AskUserQuestion 问）
- 选 Option A/B/C？
- 是否走 spec 阶段？（适合：接口边界复杂 / 有外部 consumer）
- 是否走 tdd 阶段？（适合：核心逻辑 / 有现成测试入口）

## 6. risks
（每条 risk 必须配 mitigation 或"接受"）
| # | risk | likelihood | impact | mitigation |

## 7. rollback plan
（如果上线后出问题怎么 revert，最少 1 句话）

## 8. 给 senior 看的 5 行 summary
（紧凑版，senior 异步审核可以只看这段）
- 改了什么: ...
- 为什么这样改而不是另一种: ...
- 风险: ...
- rollback: ...
- 想要 senior 拍板的具体决策点: ...

## 9. Deferred Decisions（继承自 clarify + 这阶段新增）
<列表>
```

## Phase 3: junior 决策 trade-off

调用 AskUserQuestion，把 §5 的每个 trade-off 摆给 junior。

**关键：让 junior 选 spec / tdd 是否启用**：

```
是否在这个 ticket 里走 spec-driven 阶段？
  (a) 是 — 适合接口边界复杂 / 有外部 consumer / 修改公共 API
  (b) 否 — 适合内部小改动 / 已有清晰 interface
  (c) 让 agent 帮我判断 — 我会给你建议然后你选

是否在这个 ticket 里走 TDD 阶段？
  (a) 是 — 适合核心业务逻辑 / 已有 unit test 框架
  (b) 否 — 适合 glue code / refactor / config 类改动
  (c) 让 agent 帮我判断
```

junior 选 (c) 的话，agent 给一个明确推荐 + 理由，然后再 AskUserQuestion 确认。

## Phase 4: senior 待审包

如果 clarify 的 deferred decisions 里有 senior owner 标记，**或** design 阶段新增 deferred decisions，**或** §5 里有"agent 信任度 = low"的 option，→ 必须产出 senior async review packet。

```bash
SENIOR_PKG="${HOME}/.turnkey/artifacts/${TICKET_ID}/02-senior-async-review.md"
```

`${SENIOR_PKG}` 结构（极简，**给 senior 看的，不是给 junior 看的**）：

```markdown
# Senior Async Review — ticket <ticket_id>

> Junior: <junior name 如果 runlog 有>
> Estimate to review: 5 minutes
> Review by: <date + 1 day, by default>

## What I'm building
<2 行 summary>

## Why I'm asking
<1-3 个具体决策点>

## What I plan to do (default if you don't reply)
<具体方案 + 时间表>

## What scares me
<risks 摘要 + mitigation>

## Files I'd like you to glance at (optional)
<list>

## How to reply
- ✅ "Looks good, ship it" → just react with 👍
- ⚠️ "Hold on" → reply specific concern; junior will pause turnkey at <next stage> until resolved
- ⛔ "Wrong approach" → propose alternative, junior will restart from clarify
```

把 `${SENIOR_PKG}` 的位置 print 给 junior，告诉他**怎么发给 senior**（typically: copy paste to slack / email），并提示这是异步的——可以继续走 spec / tdd / develop（不阻塞），但 review 阶段会等 senior 回复。

## Phase 5: 写入 inbox + runlog

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.design.status = "done";
r.funnel.design.ended = new Date().toISOString();
r.funnel.design.artifacts = [process.env.OUT, process.env.SENIOR_PKG].filter(Boolean);
// 根据 junior 在 Phase 3 的选择决定下一阶段
const useSpec = /* from inbox or AskUserQuestion result */;
const useTdd  = /* same */;
if (useSpec) r.current_stage = "spec";
else if (useTdd) r.current_stage = "tdd";
else r.current_stage = "develop";
// 标记可选阶段
if (!useSpec) r.funnel.spec.status = "skipped";
if (!useTdd)  r.funnel.tdd.status  = "skipped";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",
  JSON.stringify({ts:new Date().toISOString(),type:"stage_exit",stage:"design",data:{useSpec,useTdd,artifacts:r.funnel.design.artifacts}})+"\n");
'
```

## 不要做

- ❌ 不要在 design doc 里只写一个 option（必须 ≥2，让 junior **看见** trade-off 存在）
- ❌ 不要把 agent 推荐写成"唯一选项"——junior 必须有否决权
- ❌ 不要在没有 deferred decision 的情况下也强制生成 senior packet（避免 senior alarm fatigue）
- ❌ 不要在 design 阶段 commit 任何源码改动（只允许写 artifact + 可能写 spec stub 文件供 spec 阶段消费）

## 三盲扫描钩子

- 如果 junior 选 Option 时反复问"哪个对"——trust-blindness 信号（他在让 agent 替他决策）
- 如果你写了一个 Option 而它跟 onboard 里某个 convention 直接冲突——convention-blindness 风险，加 risk 表
- 如果 §6 里某条 risk 提到"会改另一个团队 owns 的代码"——context-blindness 信号
