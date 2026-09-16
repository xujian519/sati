# Agent Note: 活跃 turn 绝对投影（协议 1.9，上游 #593 切片）

Status: implemented

## Problem

长回答流到一半时刷新页面，重放出来的正文**从中间开始**——开头整段消失。

根因是活跃 turn 的重放日志有上限：`InProcessGateway` 按 `ACTIVE_TURN_EVENT_LIMIT`
（500 条）/ `ACTIVE_TURN_BYTE_LIMIT`（256 KB）截断事件，且截断用 `events.shift()`
**从头部丢**，丢掉的正好是同一段正文最早的那些 delta。实测（本机，一次 6000 字回答）：

```
deltaFrames=500  deltaTextLen=909  deltaStarts="测量方法即等于缺乏可验证的判断基准。\n\n"   ← 中段起
projectionLen=2398               projectionStarts="以下成稿中涉及的《专利审查指南》章节与司…" ← 真开头
```

`truncated` 标记虽然存在（`GatewayActiveTurnSnapshot.truncated`），却在 `ui/src` 与
`ui/server` 无任何消费点——桥侧的 `getSessionActivityViaGateway` 只取
`active/activeRunId/events`，把它静默丢掉，所以宿主连"文本不全"都不知道。

同时 delta 帧没有稳定身份：`assistant_text_delta` / `assistant_thinking_delta` 只带
`text`，唯一身份是 `runId`，因此"补一段绝对文本"在 UI 侧没有落点——`stream_delta`
是无条件**前缀追加**，发全文会叠加成重复文本。

## Decision

网关侧为每个 turn 维护**绝对投影**：按 `(通道, epoch)` 分段保留正文全文，且**永不参与
事件日志的截断**。epoch 在通道切换处递增（`model_request_started` 清空 currentKind，
于是下一步的首个 delta 触发切段），语义是"该通道的第几段"，空步不占号。

协议 1.9（无新方法，只填 `changes`）：`active_turn_snapshot` 响应新增可选
`projection: { runId, blocks: [{ kind, epoch, text, inflight? }] }`。形态对齐 1.6
（同样是"给 active_turn_snapshot 加可选字段"）。旧客户端忽略该字段即退回旧行为。

桥侧（`ui/server/sati-bridge.js#buildActiveTurnMessages`）：
- 只把 **`inflight` 的正文段**映射成一帧 `kind: "text"` + `role: "assistant"` +
  稳定 id `active-turn:<sessionId>:<runId>:text:<epoch>`；
- 该帧插在**最后一个正文 delta 的位置**（不是末尾）：`tool_use` 会把流式行
  `finalizeStreaming` 掉并换 id，投影帧若排在其后就会另建一行、显示成重复文本；
- 顺带修掉 `activeRunId: snapshot.activeRunId` —— `GatewayActiveTurnSnapshot` 上没有
  这个字段（只有 `runId`），该赋值恒为 `null`，稳定 id 也需要真正的 runId。

UI 侧（`useChatRealtimeHandlers`）：投影帧不走 `appendRealtime`，而是把当前流式行
**推进**成投影文本——行内容是该段的子串时覆盖（补齐被截断的开头），行内容不在其中
（本帧之后又到了新 delta）时丢弃本帧。重复轮询因此天然幂等，已验证同一次投影连喂
两次行内容不变。

## Alternatives considered

- **上游原样 blockId 打穿**（给 canonical delta 加 blockId，四个 provider stream、
  assembleModelMessage、AgentLoop、eventMapping、事件矩阵、llm-replay fixture 全链路跟着动）
  — 落选：改动面大一个数量级，且会改变请求内容哈希导致全部 fixture 重录；epoch 序号
  对"绝对投影"这一目标已充分。
- **滤掉事件流里已被投影覆盖的 `assistant_text_delta`**（方案原文的写法）— 落选：
  未实现 `projection` 的对端（RemoteGateway 连旧版网关）会把正文整段丢掉，违反协议
  MINOR 的 feature-detect 约定。两路并存不会产生重复：收敛点在 UI 的同一条流式行上
  （覆盖而非追加），且投影帧插在最后一个 delta 之后。
- **用 `kind: "stream_delta"` 承载绝对文本** — 落选：该形态在 UI 是无条件前缀追加
  （`useChatRealtimeHandlers` 的 `updateStreaming(sid, currentText + text)`），发全文
  会叠加成重复文本，与 thinking 通道今天的问题同形。
- **按 id upsert 成一条新的 `kind: "text"` 消息**（方案原文的写法）— 落选：tab 里已有
  实时流式行时，id 不同 → 会**并存两行**，屏幕上是重复文本；且实时 delta 继续追加到
  原行，两行都会长。改为推进原行后，新建行与推进行是同一行。
- **提高 `ACTIVE_TURN_EVENT_LIMIT` / `BYTE_LIMIT`** — 落选：只是把天花板抬高，长回答
  照样丢开头。
- **投影 thinking 通道** — 落选（本批不做）：`kind: "thinking"` 在 UI 同样是无条件追加，
  而重放应用路径只按全文等价判重（`getActiveTurnReplayMessagesToApply`），
  `"abc"` → `"abcdef"` 会被二次追加成 `"abcabcdef"`。修它需要改 UI store，超出本批范围。
  **已知缺口**：思考通道在长 turn 里仍可能丢开头。
- **在桥侧把 `truncated` 透给 UI 让用户自己看** — 落选：UI 无法恢复没被送出的字节，
  提示只是把问题转嫁给用户。

## Consequences

- 长回答刷新后正文含开头；实测同一次回答里事件流只剩 909 字中段片段时，页面渲染出的
  是含开头的完整段落，且该开头在页面上只出现一次（幂等）。
- 投影持有本 turn 的完整文本，内存上界为 `maxOutputTokens × 步数`。这与 transcript
  已落盘的同一份内容同量级；若需收紧，应限制保留的 epoch 总数并标记降级——**不能**按
  字符截断，那会重新引入丢失。
- 桥侧多出一段"投影帧"路径，且**恢复依赖 UI 侧的推进规则**：未来若有人把投影帧改走
  `appendRealtime`（按 id upsert），重复文本会立刻回来（`ui/server/sati-bridge.test.js`
  的帧序断言 + `useChatRealtimeHandlers.test.tsx` 的四态断言是这一点的防线）。
- 只投影 `inflight` 段：已完成的段在 turn 进行中就已随该步的 assistant 消息落进持久
  转录（`responseAssembly` 的 `onDurableMessage`，每步一条），由历史刷新给出。实测
  turn `3036118a` 的转录里正是一条 21 字的"我先核验…" + 一条 8431 字的正文。
- 事件矩阵因 `InProcessGateway.ts` 行号位移需重生成（`pnpm gen:event-matrix`），属预期。
