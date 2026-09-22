# Agent Note: 全量压缩的「空转」熔断

Status: implemented

## Problem

全量压缩（Tier 3）会调用模型生成摘要并按计划丢弃被摘要覆盖的历史。它是否值得做，原有判据只有一条：
**省下的 token 比例**（`FULL_COMPACTION_MIN_EFFECTIVE_SAVINGS_RATIO`，`consecutiveIneffectiveFullCompactions`）。

这条判据漏掉一类失控：**token 确实省下来了，但没换来任何推进**。形态是「压缩 → 模型重新读回同样的内容 →
再次超限 → 再压缩」。每一轮都烧掉一次摘要模型调用、丢掉一段历史，而下一轮照样触发；比例判据每轮都判
「有效」，于是没有上限。上下文越贴近上限、单轮工具调用越重（读大文件、跑检索），越容易进入这种状态；
用户侧只看到历史莫名变短、响应变慢，看不到原因。

参考底稿（ZCode）用**工具轮间隔**作为正交判据：连续两次压缩之间若没有真实工具轮，说明压缩在空转。

## Decision

**判据**：连续两次全量压缩之间至少要有 `FULL_COMPACTION_MIN_TOOL_TURNS = 1` 个真实工具轮；
连续 `FULL_COMPACTION_RAPID_REFILL_LIMIT = 2` 次不满足即熔断（有界，允许一次误判）。

**计数与归属**：
- 计数器 `toolTurnsSinceLastCompaction` + `consecutiveRapidRefills` 落在 `DefaultContextRuntime`——
  它每会话构造一份、随会话驱逐归零。**不**放 per-run 的 `TurnRuntimeState`（每次 run 重建，跨用户 turn 会丢），
  也**不**放进程级全局（多会话互相污染）。
- 工具轮由 `AgentLoop.executeToolCalls` 每执行完一批工具调用上报一次（`context.noteToolTurn()`，
  接口上的可选方法，最小运行时 no-op）。**失败批也计数**：工具全错不构成「压缩有理」，
  它同样证明模型在试图推进。
- 记账点在全量压缩真正完成之后（无摘要且无兜底早退的路径不计，「没压成」不算一次压缩）。

**熔断的表达是「不压缩 + 留痕」，不是抛错**：门口返回 `{ type: "skipped" }` 并打 `full_compaction_circuit_open`
（warn 级，带两个计数器与 snapshot）。抛错会被 `runAutoCompact` 的 catch 吞掉，而那个 catch 会用
`truncateHeadKeepRatio(0.5)` **再砍一半历史**——把「拒绝压缩」变成「静默丢一半上下文」。

**门开条件包含「距上次压缩仍无工具轮」**（而不只是「历史上空转过」）：一旦出现真实工具轮，门即自行打开。
否则熔断打开一次就再无法关闭，用户后续正当的压缩需求会被永久拒绝。

**顺带补的留痕**：`runAutoCompact` 的兜底截断（有损、无摘要）原本完全静默，现在打 warn
（`fell back to head truncation`，区分 `not_compacted` 与 `compaction_failed`）。熔断与冷却跳过压缩时
正是它被触发，不记就永远看不清历史为何变短。

**熔断范围是 Tier 3**：Tier 1（micro）/ Tier 2（snip）不调模型、不丢语义，照常运行。

## Alternatives considered

- **沿用/加强比例判据（提高阈值、加入压缩次数上限）** — 落选：比例是「省了多少」，与「有没有换来推进」
  正交。压缩 30% 后模型立刻读回 30% 的形态里，比例判据永远判有效；单纯提高阈值只会让本来有效的压缩
  被拒。需要的是第二个信号，不是更严的同一个信号。
- **抛错终止 turn（照参考底稿）** — 落选：`runAutoCompact` 的 catch 会吞掉异常并对 `state.messages`
  做无摘要的一半截断（`fallbackTruncateRatio: 0.5`）。要「抛错终止」必须先让错误穿出该 catch 或引入
  显式 outcome 字段——那是跨调用点的改造，而本判据要解决的是「别再压」，不是「终止会话」。
- **把计数器放 `TurnRuntimeState`** — 落选：per-run 生命周期。全量压缩可能跨 turn 发生
  （pre-routing 每轮都评估），计数器在 turn 边界归零就永远观察不到空转。
- **把计数器放 `DoomLoop` 或进程级全局** — 落选：`DoomLoop` 的依赖槽位在 `src/` 内实际无人赋值
  （只有测试构造），而进程级全局会被多会话互相污染。
- **只在 pre-routing/post-routing 检查、放过 model-error-recovery** — 落选：恰恰是错误恢复路径
  （PTL 后 compact_and_retry）最容易空转，也正是最贵的一条（每次都可能是长摘要在失败边缘重试）。
- **熔断后立刻关闭会话 / 要求用户开新会话** — 落选：过度反应。系统已有终局路径
  （`ContextOverflowRecovery` 的二次截断），熔断只需停止无谓的摘要调用并留痕。
- **给 `AutoCompactResult` 加 `circuit_open` 变体，让调用点分别处理** — 落选：现有 `skipped` 的语义
  就是「本次不压缩」，而调用点对 skipped 已有既定处置（恢复路径的兜底截断）。新增变体只为区分日志原因，
  却要让三个调用点都分支，收益不抵改动面。原因留在日志与计数器的名字里。

## Consequences

- 换来了：空转有界——最多两次无推进的全量压缩后停止烧摘要调用；原因在日志里可查
  （`full_compaction_circuit_open` / `full_compaction_rapid_refill`）。
- 代价（有意）：熔断期间上下文可能停在超限边缘而不推进，用户可能收到模型侧的超限错误。
  这是「不再假装能压」的代价，比静默烧调用与丢历史更诚实；恢复路径的兜底截断仍会执行，现在有留痕。
- 计数器在 `noteToolTurn` 未接线时恒为 0——那会让熔断在两次压缩后打开且不再关闭。因此这条接线
  必须有测试（`tests/agent/loop/tool-turn-signal.spec.ts`）；判据本身在
  `tests/context/compaction-engine.spec.ts` 覆盖「熔断」「不再调摘要模型」「一次工具轮后自行恢复」。
- 与既有冷却（`fullCompactionCooldownUntil`，30s）并存且正交：冷却管「刚压过，先等」，熔断管
  「压了也没用，先停」。两者日志分开，便于区分原因。
