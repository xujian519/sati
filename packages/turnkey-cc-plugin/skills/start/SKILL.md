---
name: turnkey
description: Turnkey workflow for "三新 junior" (new to the codebase, new to the stack, new to the team conventions) tackling a new feature ticket on an unfamiliar codebase. Routes through 8-stage funnel — onboard → clarify → design → [spec] → [tdd] → develop → test → review → ship — with senior-gate checkpoints and three-blindness (convention/trust/context) scans. Use when the user types `/turnkey:start "<ticket>"` or asks to start a turnkey workflow on a new ticket. NOT for senior solo flow (use Claude Code's normal agent), NOT for codebase exploration alone (use `/turnkey:onboard` directly), NOT for fixing existing bugs (use Claude Code's debug flow).
argument-hint: "[start <ticket> | onboard | clarify | design | spec | tdd | develop | test | review | ship]"
---

# turnkey — main orchestrator

> 你是 agent。这份 SKILL.md 让你**陪一个三新 junior** 走完一个 ticket 的全流程。
> Junior 的失败模式不是"写不出代码"——AI 已经能写。Junior 的失败模式是
> **convention-blindness（违反代码库默认）、trust-blindness（盲信 AI 输出）、context-blindness（不懂业务历史）**。
> 你的任务是结构化地帮他**绕开**这三盲，**不是**替他思考。

## 你**不**做的事（硬约束）

- ❌ 不替 junior 决定 trade-off（"用 redis 还是 in-memory cache" → AskUserQuestion 让 junior 选 + 给他足够信息选）
- ❌ 不在 senior gate 阶段假装自己是 senior（review 阶段要明确产出"senior 待审包"而不是"我审过了"）
- ❌ 不跳阶段（即使 ticket 看起来很小，也走完 onboard + clarify，至少**确认**这俩可以快速过）
- ❌ 不沉默执行 destructive 命令（`git push -f` / `rm -rf` / 数据库改动 → 二次 AskUserQuestion）
- ❌ 不假装 funnel 进展（"phase X done" 必须有真实 artifact 写到 `~/.turnkey/artifacts/<ticket_id>/`）

## Phase 0: bootstrap（每次 /turnkey 调用都先跑这段）

> ⚠️ **必须用单一 Bash 调用**(不要拆成多个并行 tool_use)。
> 历史教训:某些 proxy 链路对 multi-tool streaming 处理脆弱(详见 ticket fbbf49c3a154),
> 把 bootstrap 收敛为一次 `node` 调用既最稳也最快。

把 `<原始 ticket 文本>` 替换为 junior 的实际 ticket text,然后**只发一个** Bash 调用:

```bash
node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-bootstrap.js "<原始 ticket 文本>"
```

stdout 会是一行 JSON,例如:

```json
{"ticket_id":"abc123def456","artifact_dir":"/Users/.../artifacts/abc123def456","action":"new","runlog":"/Users/.../runlog.json","archived":null,"home":"/Users/.../.turnkey"}
```

字段含义:
- `action`: `"new"`(新 ticket,已用 templates/runlog.template.json 种子写好 runlog) 或 `"resume"`(同 ticket_id 已有 runlog,直接续跑)
- `archived`: 若 ≠ null,旧 runlog 已归档到该路径
- `home`: 实际生效的 turnkey 状态目录(尊重 `TURNKEY_HOME` env;默认 `~/.turnkey`)

把这行 JSON 直接 parse,后续阶段用其中的 `ticket_id` / `artifact_dir`。

> ⚠️ 若 hook 不存在(老的 plugin 安装或开发模式),退化:
> 报告 junior "Phase 0 hook missing — 请确认 plugin 已正确安装,然后重试 /turnkey:start"。
> **不要**手动展开 4 块原始 bash —— 那条路径已知会撞 multi-tool proxy bug。

## Phase 0.5: context budget pre-flight（每次进 Phase 1 前必跑）

> 见 `CONTEXT-PROTOCOL.md`。这一步是 P0 引入的、防止 chat scrollback 把上下文吃满的保险丝。

```bash
LEVEL="$(jq -r '.context_budget.level // "green"' ~/.turnkey/runlog.json)"
USED="$(jq -r '.context_budget.current_estimate // 0' ~/.turnkey/runlog.json)"
WIN="$(jq -r '.context_budget.model_window // 200000' ~/.turnkey/runlog.json)"
```

按 `LEVEL` 走对应分支：

- **`green`** → 直接进 Phase 1，不打扰 junior。
- **`yellow`**（≥40%）→ 进 Phase 1，但在调用 sub-skill 前对 junior print 一行：
  > ⚠️ context ~${USED}/${WIN} tokens (~yellow). 本阶段优先读 artifact + digest，**不要**回滚 chat scrollback 找早期细节。
- **`orange`**（≥60%）→ **不要**直接进 Phase 1。先 AskUserQuestion：
  > context 已用 ~${USED}/${WIN} tokens（orange）。继续可能在中途被截断。建议：
  > (a) 让 agent 立刻把已完成阶段的 artifact 压缩成 digest（P1 turnkey-digest，目前需手动总结）
  > (b) 我先手动复制关键 artifact 路径，开新 cursor session 用 `/turnkey` resume
  > (c) 强制继续（接受截断风险）
- **`red`**（≥80%）→ 阻塞。Print：
  > ⛔ context ~${USED}/${WIN} tokens (red). 必须先压缩或交接，不能进下一阶段。
  > 然后 AskUserQuestion 同 orange 三选一，但**移除 (c) 强制继续**。

无论分支结果如何，把当前 LEVEL 决定记进当前阶段的 artifact 头部（"context budget at stage entry: <level>"），方便 R1/R2 复盘。

## Phase 1: 路由到当前 stage

```bash
CURRENT_STAGE="$(jq -r .current_stage ~/.turnkey/runlog.json)"
```

按 `CURRENT_STAGE` 的值，**显式声明**你即将做什么，然后调用对应的 sub-skill：

| current_stage | 调用的 sub-skill | 简述 |
|--------------|----------------|------|
| `init` 或 `onboard` | `skills/onboard/SKILL.md` (`/turnkey:onboard`) | codebase 体检 + 三盲基线 |
| `clarify` | `skills/clarify/SKILL.md` (`/turnkey:clarify`) | junior-answerable 问卷 |
| `design` | `skills/design/SKILL.md` (`/turnkey:design`) | 方案 + senior 待审包 |
| `spec` | `skills/spec/SKILL.md` (`/turnkey:spec`) | (可选) spec 驱动 |
| `tdd` | `skills/tdd/SKILL.md` (`/turnkey:tdd`) | (可选) 测试先行 |
| `develop` | `skills/develop/SKILL.md` (`/turnkey:develop`) | 分块实现 + 信任校验 |
| `test` | `skills/test/SKILL.md` (`/turnkey:test`) | unit / integration / e2e |
| `review` | `skills/review/SKILL.md` (`/turnkey:review`) | 自审 + PR 准备 |
| `ship` | `skills/ship/SKILL.md` (`/turnkey:ship`) | 部署 + 7d regression watch |

读取 sub-skill 的全文，**按 sub-skill 的指令执行**，完成后回到这份 SKILL.md 的 Phase 2。

## Phase 2: stage-gate 判定

每个 sub-skill 完成后：

```bash
node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-stage-gate.js --stage "${CURRENT_STAGE}"
```

返回值：
- `0` = pass，可以进下一阶段
- `1` = blocked，stage-gate 写了 blocker 进 inbox.jsonl
- `2` = need-human，需要 senior / junior 自己拍板

如果 `0`：把 runlog 的 current_stage 推进到下一阶段，回到 Phase 1。
如果 `1`：把 blocker 原因 print 给 junior，问他要不要自己 override（AskUserQuestion）。
如果 `2`：用 AskUserQuestion 把 blocker 的关键问题摆给 junior，让他选（或选"召唤 senior"）。

## Phase 3: funnel 完成 / 阶段交付

每完成一个 stage，往 `~/.turnkey/artifacts/${TICKET_ID}/` 写一份 markdown 摘要：

```
artifacts/<ticket_id>/
├── 00-onboard-summary.md
├── 01-clarify-summary.md
├── 02-design-doc.md
├── 03-spec.md            (可选)
├── 04-tdd-plan.md        (可选)
├── 05-develop-log.md
├── 06-test-report.md
├── 07-pr-package.md      ← senior 待审包，最重要
└── 08-ship-checklist.md
```

每份产物**必须**有：
- 该阶段的关键决策（decisions made）
- 该阶段没做的取舍（decisions deferred + 为什么）
- 该阶段触发的三盲信号（convention / trust / context）

## Phase 4: ship 完成后

调用 `skills/ship/SKILL.md` (`/turnkey:ship`) 的 §closeout 段，把 8 阶段 process funnel 导出为 5 阶段 outcome funnel 的初始填表（给 operator 后续 R1 研究用）。

最后，print 一段 closeout：

```
turnkey ticket <ticket_id> COMPLETE
funnel: onboard ✓ clarify ✓ design ✓ [spec ✓|skipped] [tdd ✓|skipped] develop ✓ test ✓ review ✓ ship ✓
artifacts: ~/.turnkey/artifacts/<ticket_id>/
PR: <url if pushed>
next: 7-day regression watch starts now (turnkey-ship Phase 6)
```

## 异常处理

**情况 A: junior 在中途说"我不想走这套，直接写代码"**

不阻拦。但产出一份 `~/.turnkey/artifacts/<ticket_id>/00-bypass-notice.md` 记录他在哪个 stage 跳出来、跳的理由、当时未回答的关键问题。这是给后续 R1/R2 research 用的反例样本。

**情况 B: hook 没装**

第一次跑发现 `${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-stage-gate.js` 不存在 → print 一条 warn 但**不**阻塞，stage-gate 退化为 advisory（你自己用 SKILL 里的判定逻辑判 + 自己写 inbox 行）。

**情况 C: ticket 超大 / 太抽象**

onboard 阶段读 ticket 后，如果你判断这个 ticket 是 epic 级别（>5 个独立子 feature），调用 AskUserQuestion 让 junior 选：
- (a) 切第一个 sub-feature 出来跑 turnkey
- (b) 整个 ticket 全跑（warn：funnel 会很长）
- (c) 退出，让 junior 先去拆 ticket
