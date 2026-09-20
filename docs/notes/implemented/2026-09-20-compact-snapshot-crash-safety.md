# Agent Note: 压缩快照的崩溃安全（上游 PilotDeck #599 引入）

Status: implemented

## Problem

压缩的落盘形态是**两条时序记录**：先写 `control_boundary`，再逐条写替换消息
（`src/agent/turn/TurnRunner.ts` 的 `onCompactPersisted`）。重放则以「边界存在」为唯一
判据丢弃边界前历史（`TranscriptReplay.replayFull` 的 `beforeBoundary`，由
`findLastCompactBoundaryIndex` 供给）。两者叠加出三个数据丢失窗口：

1. **记录间崩溃**：边界已落盘、替换消息未落盘（或只落前半）⇒ 重放丢掉原文历史，
   只恢复残缺替换内容。Sati 的写入是**批量缓冲**（64KB / 50ms 兜底，或显式
   `flushCheckpoint`），而边界与逐条替换消息之间夹着异步输出门禁调用，50ms 兜底
   定时器极可能先把「仅边界」这一批落盘。
2. **turn 未完成**：替换消息是普通 `durable_message` 条目，重放对它们施加
   `completedTurnIds` 过滤。压缩发生在 turn 进行中，崩溃后该 turn 无 `turn_result`
   ⇒ 替换消息**全部**被跳过，而原文历史已被丢弃 ⇒ 模型可见上下文近乎清空。
3. （第三条窗口 Sati 已有独立实现覆盖：截断尾不得吞并下一条记录，见
   `JsonlTranscriptWriter` 的 `tailProbed`/`tornTail` 与单条 `write(2)`。）

**先复现再动手**（P0）：`tests/session/compact-snapshot-crash.spec.ts` 四条用例全部红灯，
失败值即症状——`边界已落盘而替换消息全部未落盘` 的模型可见投影是**空串**，
`legacy 替换记录` 一案只剩 `partial replacement tail` 一条残缺内容。

## Decision

采用上游 #599 的单记录快照形态，并按 Sati 的既有分工做了四处本地化改造：

1. **快照内联进边界记录**：`TurnRunner.onCompactPersisted` 不再逐条 `recordDurableMessage`，
   改为把整份替换上下文写进 `boundary.snapshot = { version: 1, messages }`。**授权丢弃历史**
   与**替换内容完整**由此变成同一份记录的两面。
2. **有效性门控取代存在性判据**：新增 `src/session/transcript/CompactSnapshot.ts` 的
   `readCompactSnapshot`（逐层校验版本、非空、role、逐 content block 形状）作为唯一授权；
   `replayFull` 只在快照有效时丢弃边界前历史，否则保留原文并发
   `transcript_entry_invalid` warning。效力**不依赖 turn 完成**——落盘那一刻替换内容已完整。
3. **保留输出门禁**：Sati 的压缩重放消息本来要过 `PatentOutputGate`（免责声明等质量处理），
   上游形态会丢掉这一步。改为先 `processMessage(..., { skipApproval: true })` 取门禁后文本，
   再内联进快照——门禁语义不变，只是"写哪去"变了。
4. **职责拆分**：`findLastCompactBoundaryIndex` 保持「任意边界」语义（`editLastTurn` 的
   压缩尾巴前置校验、`replayShadowedMessages` 的原文展开都需要认识 legacy 边界），
   新增 `findLastCompactSnapshotIndex` 供重放授权。

配套两种 Sati 官有耦合的修复：

- **遮蔽索引对齐**：`projectFullMessageSequence` 补上快照消息（快照形态下替换内容不再是
  条目），且 `replayShadowedMessagesAt` 的输入切片改为**含上次边界自身**——否则多压缩会话里
  后一次压缩的 `shadowedRanges` 索引会整体缺一段。
- **fork 重定向**：抽出 `mapTranscriptEntryMessages`，把快照内消息纳入路径重定向与 carryover
  标记，并把 `control_boundary` 加入 `retargetEntriesToSession` 的处理集。否则分叉会话的
  快照继续指向**源会话目录**的媒体/溢出文件。

**legacy 口径（本 PR 的行为变化，取上游判别口径 A）**：既有会话磁盘上是 legacy 形态
（边界无快照 + 逐条替换记录）。改动后这类边界**不再授权丢弃历史**，legacy 替换记录被跳过，
原文历史照常进入模型上下文——即「压缩被保守回滚」，与上游文案一致（may require compaction
again after resume）。

## Alternatives considered

- **照搬上游 `prepareTail()` 与 `flush: true`（fsync）** — 落选：Sati 的 `JsonlTranscriptWriter`
  已有更强的 torn-tail 处理（逐记录 `write(2)` + 短写循环 + 首写前探测补换行），而全仓无 fsync
  传统。单记录形态下「快照记录不完整 ⇒ 不授权丢历史」，崩溃安全不依赖 fsync；`flush: true`
  是给上游无批量缓冲的形态补的，照搬是降级。
- **双轨兼容（legacy 保持旧行为，仅新快照走新路径）** — 落选：重放要长期背两条授权路径，
  而 legacy 路径正是缺陷所在；单路径 + warning 更易审计。代价是既有已压缩会话下次续算上下文
  变长、可能触发再压缩（可接受，且可逆）。
- **快照另存 sidecar 文件（边界只存引用）** — 落选：又把「完整性」拆回两条记录/两个文件，
  崩溃窗口换汤不换药；内联进同一条 JSONL 记录才是最小原子单位。
- **在 `compactionExecutor` 的 catch 里补落盘** — 落选：压缩产物在成功路径上就产生，
  失败补写解决不了「成功但只写了一半」这一主窗口。
- **快照消息也走 `completedTurnIds` 过滤（与普通条目一致）** — 落选：压缩发生在 turn 内，
  崩溃后该 turn 必然未完成，过滤等于让修复失效。
- **`readCompactSnapshot` 只接受 `AgentTranscriptEntry`** — 落选：内存写入口
  （`InMemoryTranscriptWriter`）用的是轻量条目形状，且校验器的职责本就是面对"不可信形状"，
  入参收窄为 `{ type: string; boundary?: unknown }` 后两类调用方都能用，且免去断言。
- **给 subagent Web 投影的 `sawExecutionMessage` 补快照分支** — 未做：快照不再是消息条目，
  子代理会话若在产生任何真实消息之前就压缩，其边界行可能不再渲染。属纯展示边缘（见 Consequences），
  与崩溃安全无关，留待需要时再动。

## Consequences

- **不变量**：只有「带完整且可校验快照」的边界才授权重放丢弃边界前历史；否则一律保留原文。
- **磁盘格式**：`AgentControlBoundaryTranscriptEntry.boundary` 增可选 `snapshot`
  （`CompactSnapshotPayload = { version: 1; messages: CanonicalMessage[] }`）。只增字段，
  legacy 记录照常可读；`TranscriptReader` 泛化解析，无剥离风险。
- **行为变化**：① legacy 边界不再遮蔽历史（原文回归上下文，可能触发再压缩）；
  ② 替换消息不再作为独立 `durable_message` 条目落盘（`extractWebVisibleMessages` /
  `extractSubagentExecutionMessages` 本就把它排除在 Web 投影外，故 UI 无可见变化）；
  ③ 跨进程续算形态判定更准确——边界记录不算「响应已到」，压缩后立即崩溃仍判 (a) 形态自动续算。
- **测试面**：新增 `tests/session/compact-snapshot-crash.spec.ts`（4 条，先红后绿）与
  `tests/web/fork-compact-snapshot.spec.ts`（1 条，负控制：摘掉 `control_boundary` 重定向 ⇒
  快照内媒体路径停在源会话目录）；`transcript-replay-compaction.spec.ts` 改写为快照/legacy 双契约；
  四份 fixture（`project-messages` / `shadowed-messages-replay` / `transcript-replay-cache` /
  `output-gate-wiring` D5 两条）由 legacy 形态迁到快照形态，D5 的「压缩重放走门禁且不重复挂起」
  断言改为读快照内容。
- **残留**：① 子代理 Web 投影的 `sawExecutionMessage` 微差（见 Alternatives 末条）；
  ② fsync 加固（P4）未做——当前崩溃语义由单记录形态保证，断电丢整批等价于「压缩回滚」而非丢历史。
- **回填**：新增源文件已按纪律跑 `pnpm gen:doc-claims`（`docs/code-facts.md` src 模块索引）与
  `pnpm measure:update`（`docs/technical-debt/metrics.md` 文件数/行数基线）。
