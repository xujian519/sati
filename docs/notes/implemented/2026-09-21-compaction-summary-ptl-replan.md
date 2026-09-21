# Agent Note: 摘要请求自身超窗时的反向重选（PTL replan）

Status: implemented

## Problem

全量压缩的摘要调用（Tier 3）把「被遮蔽区段」的投影发给模型。当这段投影**自己**超过模型上下文窗口时，
provider 返回 PTL（prompt too long）。今天这条错误走的是通用失败路径：

1. `summarize` 把 provider 的**结构化错误**丢成 `new Error(event.error.message)`——`code`、
   `recoverableViaCompact`、`maxContextTokens` 全部丢失，调用方只剩一句 message，无法判断这是 PTL；
2. 于是按普通失败处置：**60s 冷却** + `buildDeterministicFallbackSummary`（机械摘要）。

结果不是数据丢失，而是质量与语义的退化：本该由模型做语义总结的历史，被替换成机械抽出的
Objective/State/Decisions 列表；且同一段超窗输入在冷却结束后还会再撞一次。

正确的反应方向相反：**保留更多近期原文**（少总结）。摘要输入变小，才可能压得动；继续压只会让
「要总结的部分」更大，下一轮必然再超窗。

## Decision

- **保留结构化错误**：`summarize` 遇到 `error` 事件时抛 `SummaryModelError`（携带原
  `CanonicalModelError`），不再降级成 `new Error(message)`。只有它能判断「这是 PTL 吗」以及
  「provider 说窗口多大」。
- **判据下沉 model 层**：`isPromptTooLong` 从 `src/agent/loop/modelErrors.ts` 移到
  `src/model/errors/promptTooLong.ts`（入参收窄为 `code` / `message` / `recoverableViaCompact`
  三字段的 `PromptTooLongSignal`）。两个消费者是 agent 层的错误恢复与 context 层的压缩，
  而 context 层不得反向依赖 agent 层。行号与调用点无变化，行为逐字节相同。
- **计划整体重算、且先于任何落盘**：`run()` 内的计划抽成 `planAt(ratio)`，返回
  `{ ratio, compactPlan, messagesToKeep, retainedTailExceededBudget }`。PTL 重选时**整体替换**该状态，
  所有下游引用（PreCompact 载荷、`compact_started`/`compact_completed` 的 `messagesSummarized`、
  边界标记、`CompactionResult` 的 `shadowedMessageIndexes` / `messagesToKeep`）都取当前计划。
  若是先产出边界再重算，`shadowedRanges` 会指向错误的原文（重放会把错误的段落当作被遮蔽内容）。
- **重试有界**：`MAX_SUMMARY_ATTEMPTS = 2`。目标尾比例**只增不减**，取两者较大并截到 1：
  - 报错带 `maxContextTokens` 时按「摘要集最多能占多少」反推：`(preTokens - 上限) / preTokens`
    （用整段对话 token 保守估计：摘要输入只是其投影，按整段算不会少留原文）；
  - 否则退化为「尾预算翻倍」。
  比例无法增大（已为 1，或重选后摘要集为空）**即不重试**，照旧走确定性兜底与失败冷却。
- **只对 PTL 重选**：其他结构化错误（server_error / rate_limit 等）重试同一份输入没有意义，
  仍走一次即止的失败路径。
- **留痕**：结果 `diagnostics` 增 `compact_summary_prompt_too_long`（info，带 `keepTailRatio a → b`），
  与既有的 `compact_summary_failed` / `compact_summary_fallback_used` 同一通道。

## Alternatives considered

- **保留今天的降级（机械摘要 + 冷却）** — 落选：它不是「安全兜底」而是「质量退化」，且不解决根因
  （冷却结束后同一段输入还会超窗）。机械摘要只在**真正无法总结**（重试后仍超窗、用户中断、
  模型不可用）时才是正确兜底——那仍然保留。
- **按 token gap 精确反推要移多少组（参考底稿做法）** — 部分采纳：报错带 `maxContextTokens` 时已按
  上限反推所需尾预算；但「gap → 移多少组 turn」需要 turn→token 的反函数，而计划的粒度是
  turn 组且受保护组/请求锚点约束，精确反推会引入与该约束冲突的边界情况。取「反推值」与「翻倍」
  的较大者即可，方向保证不会少留原文，代价是偶尔多留一点（少总结一点）。
- **把 `isPromptTooLong` 就地复制一份到 context 层** — 落选：两份判据必然漂移，而漂移的后果是
  「一方认为是 PTL、另一方不认」，正是本 note 要修的问题形态。
- **给 `run()` 加 `replanOnPromptTooLong?: boolean` 开关**（调用方可关） — 落选：没有第二个调用方
  需要另一种行为；开关只会变成无人维护的分支。要关掉它可以直接不传 `compactionEngine`。
- **不改计划、只把摘要输入再投影一次（更狠地砍工具输出）** — 落选：`projectMessagesForSummary`
  已做投影；再砍就是丢信息（工具结果常是任务的关键证据）。少总结（多留原文）比多丢信息更保守。
- **把重选做成无限重试直到成功** — 落选：与刚落地（2.1）的「空转熔断」直接冲突，且失败边缘的
  每一次重试都是完整摘要调用。有界一次 + 兜底，代价可预测。
- **新增 AgentEvent 通知 UI「这次重选了」** — 落选：事件面变更要同步 `docs/event-producer-consumer.md`
  与 UI 消费方，而 diagnostics 已随 `CompactionResult` 流向调用方/落盘；等真需要 UI 展示时再按 MINOR 加。

## Consequences

- 换来了：摘要请求超窗时有第二次机会产出**真正的语义摘要**（保留更多原文而非丢信息），
  最坏情况只是多一次摘要调用后仍走原兜底。
- 代价（有意）：PTL 路径最多多一次完整摘要调用；重选后遮蔽的历史更少，压缩后的 token 更高。
  若压缩后仍超限，`DefaultContextRuntime` 的既有 relaxed retry（压得更狠）会接着跑，且它会比较
  两次快照只保留更小的那个——两个方向不会互相污染结果。
- 摘要错误信息不再丢字段：诊断与日志里的 `error` 仍是 message 字符串（`CompactionResult` 形状未变），
  但引擎内部据此可判定 PTL。
- 测试钉住四条分支：重选后成功（摘要输入确实变小、状态 success、诊断留痕、遮蔽索引与重算后的计划自洽）、
  两次都 PTL 仍兜底且只调用两次、非 PTL 结构化错误一次即止、普通异常（非结构化）不触发重选。
