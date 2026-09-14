# Agent Note: 会话提示日期锚定 + 跨 UTC 日通知（上游 #571）

Status: implemented

## Problem

`<environment>now: YYYY-MM-DD</environment>` 落在 system prompt 前缀里，而前缀是 Anthropic prompt cache 的缓存键：日期一变，system 块与全部消息断点的前缀都失配，整段 prefill 按 1.25x 重写一次。此前两次取舍都不完整：

- `9cd5c91d2`（上游 #569 移植）在 runtime 构造时冻结日期——跨午夜仍活跃的会话此后每回合都发旧日期，陈旧没有上界。
- `f96dcf9e1` 改为按 UTC 自然日刷新——陈旧上界收敛到 1 天，但每会话每跨一次 UTC 日就重写一次 system 前缀（对 UTC+8 用户即北京时间 08:00，落在上班时段）。

上游 `v2026.09.14`（PR #571，4 提交 / 7 文件）给出第三条路：**日期锚定在会话内稳定，正确性由一条消息级通知承担**。

## Decision

**锚点**：`DefaultContextRuntime.promptTimeState`（每会话一条：锚点时刻 + 上次投影的逐条消息指纹 + 已追加的日期通知）在**会话首次正式组装请求**时锚定 system 日期，此后正常追加消息、重试、跨天都不改写；只有完整压缩产生新 checkpoint（boundary + 摘要头部，经 `isCompactionCheckpointHead` 判定）才重新锚定——那时前缀本来就要重写。微压缩、头部裁剪、中间删减只允许移动通知，不允许改写 system 日期。

**通知**：跨 UTC 日时在下一次请求的消息末尾追加一条 `<date-update>` 合成 user 消息（`src/context/prompt/promptDateNotice.ts`，`metadata: { synthetic: true, purpose: "date_update" }`）。通知按投影坐标系记 `index`，后续请求保持其原位以让前缀逐字延长；落在被重写区（`index > 未变前缀长度`）的通知丢弃，并在新末尾按需补一条当前日期。通知只存在于请求投影（`prepareForModel` 的返回值），**不进 `state.messages`**，因此不落 transcript、不进 web 投影、不参与压缩锚点（`isRealUserRequestMessage` 本就排除 `synthetic`）、不参与记忆检索（记忆 query 与 `recentMessages` 取自插入通知前的投影）。

**预算预演隔离**：`ContextPrepareInput.previewOnly` 让被丢弃的候选请求（`AgentLoop.createBudgetEvaluator`）不提交锚点、通知位置与 cache generation。

**断点同源**：微压缩 `cacheBreakpoints` 改在插入通知后的最终消息数组上计算，避免下标右移把 `cache_control` 打到错误的块上。

**分类旁路**：`extractLastUserMessage` 跳过日期通知——它更新的是当日日期，不是决定路由复杂度的任务本身。

## Alternatives considered

- **维持「按 UTC 自然日刷新」（`f96dcf9e1` 现状）** — 落选：每会话每跨日一次全量前缀重写；这正是上游否掉的取舍，且触发时刻（UTC 午夜 = 北京 08:00）对常驻/长会话不友好。
- **完全冻结日期（上游 #569 原样）** — 落选：跨午夜会话此后一直发旧日期，模型对「今天」的认知无上界地陈旧。
- **把日期从 system prompt 移出、每回合都以消息形式附在尾部** — 落选：system 前缀之外的历史消息断点仍会因每日新增一条而位移，且改变了 `<environment>` 的既有语义（工具与提示词都引用它）。
- **在 runtime 里自己维护 cachePlan 状态并按上游原样移植 `previewOnly` 的「不消费压缩 reset」语义** — 落选：Sati 的 cachePlan 在 AgentLoop 构造、generation 是模块级 log-only 计数器，没有上游的 `cachePlanState`/`cacheResetSessions`；照搬会引入 Sati 不存在的状态机，只保留「不提交锚点/通知位置 + 预演不递增 generation」这一等价子集。
- **微压缩断点做下标重映射（投影坐标 → 请求坐标）而非改在最终数组上计算** — 落选：重映射函数本身是新的一处出错点，且与上游「从最终投影计算断点」的既有做法不一致；同源计算下断点语义（标记被老化工具结果的前一条消息）自然成立。

## Consequences

- 换来：会话内 system 前缀逐字稳定，跨日不再触发全量 cache 写；模型当日日期由通知保证为真（陈旧上界 0 天）。`tests/context/prompt-date-anchor.spec.ts` 覆盖跨日、重写、压缩、会话隔离、预演隔离 11 例；`tests/context/prompt-date-notice-cache.spec.ts` 锁断点与消息同源。
- 付出：请求投影里多一类合成消息（每条约 50 token，随会话内跨日次数线性累积，完整压缩时清空）；凡是「读最后一条 user 消息」的旁路都要认得它，目前只有路由分类（已过滤）与记忆检索（读投影，天然干净）两处，新增旁路时需复用 `isPromptDateNotice`。
- 已知限制：通知位置随运行时存在，进程重启/会话恢复后重新锚定为恢复当日日期（与运行时的提示时间状态同生命周期，与上游一致）。
- 被顶替的假设：`tests/context/prompt-date-freeze.spec.ts` 已删除（其断言是「跨日改写 systemPrompt」，与新语义相反）。
