# Agent Note: Edit last turn + regenerate（协议 1.7）

Status: implemented

## Problem

用户发出消息后发现有笔误、或想换种问法时，只能另发一条补充消息（污染上下文）或
fork 新会话重开。上游 PilotDeck 已提供"编辑最后一条消息并重新生成"能力，Sati 需要
等价能力：改写会话最后一轮（user 输入 + 其 assistant 回复），立即用新输入重跑。

## Decision

1. **遮蔽式 append-only 实现（不改写历史，只追加遮蔽指针）**：
   - transcript 新条目类型 `turn_rewrite`（`AgentTurnRewriteTranscriptEntry`）：
     `rewrite: { shadowFromEntryIds: string[]; reason: "edit_last_turn" |
     "regenerate_last_turn"; newText?: string }`。被遮蔽的原始条目**保留在磁盘上**，
     仅投影层跳过——append-only 纪律不破，审计/resume 不受影响。
   - `TranscriptReplay.collectShadowedEntryIds(entries)` 并集扫描；`replayFull` 与
     Web 投影（`readSessionMessages.extractWebVisibleMessages`）对被遮蔽条目跳过；
     增量投影 slice 含 `turn_rewrite` 时强制全量重投影（遮蔽可能落在 slice 之前的
     条目上，增量合并无法表达"删除"）；`projectFullMessageSequence` **刻意不遮蔽**
     （它只服务压缩「还原原貌」展示路径 `replayShadowedMessages`，非模型请求
     重建路径——模型历史经 `replayTranscriptEntries` 的 `replayFull`，那里遮蔽生效）。
   - 遮蔽集 = 最后一条 `accepted_input` 条目 + 同 turn 内其后的 assistant/
     tool_result/durable 消息条目（以该 turn 的 `turn_result` 为界，不跨 turn、
     不越 compact 边界——`findLastCompactBoundaryIndex` 预检，命中即拒绝）。
2. **服务端校验前置**（`src/web/server/editLastTurn.ts` `rewriteLastTurn`）：
   反向扫描最后一条 `accepted_input`；预检失败 reason 枚举 `no_last_turn`（无入口/
   turn 未完成）、`active_turn`（`router.hasInFlightTurn`）、`pending_approval`
   （`approvalBus.list` + `teamDb.hasPendingApproval`）、`unsupported_content`
   （非纯文本）、`compact_tail`（compact 边界晚于目标 turn）。通过后自管
   entryId/parentEntryId/sequence 追加 `turn_rewrite`（0600/0700 权限，
   仿 forkSession 范式）。成功返回 `{rewritten: true, originalText?, shadowedEntryCount?}`。
3. **协议层（1.7，MINOR）**：`edit_last_turn`/`regenerate_last_turn` 方法 +
   `turn_rewrite` 条目类型；`Gateway` 接口 optional 方法（`editLastTurn?`/
   `regenerateLastTurn?`），旧实现 feature-detect + `not_configured` 兜底
   （`{rewritten: false}`）；版本表 1.7 条目。**不做 `turn_rewritten` 广播事件**
   ——simple request/response 足够，成功后的新 turn 由既有事件流承载。
4. **UI 层**：
   - 最后一条 user 消息 hover「编辑」（Pencil）：预填 composer 进入编辑模式
     （`beginEditLastTurn`，一次性 ref，会话切换自动失效），提交时
     `handleSubmit` 拦截改发 `edit-last-turn` 帧（绕过 slash 拦截——编辑文本允许
     以 `/` 开头按原文发送），乐观 user 气泡 + Processing 状态与正常提交一致。
   - 最后一条 assistant 消息操作区「重新生成」（RotateCcw）：直接发
     `regenerate-last-turn` 帧，乐观气泡取最后一条 user 消息原文。
   - 失败 complete 帧带 `rewriteError`（complete 帧本身不可渲染，由
     `useChatRealtimeHandlers` 的 `onRewriteError` 回调宿主转 i18n toast）。
   - 成功后 turn 结束的既有 `refreshSessionFromServer` 会从服务端重读消息
     （投影层已过滤遮蔽条目），旧消息对自动消失，无需客户端本地剔除。
   - 兄弟标签页：chat.js 两分支广播乐观 user/status 帧（与 sati-command 同模式）。
5. **测试**：`tests/web/edit-last-turn.spec.ts`（4：regenerate 遮蔽+重放投影只剩
   首 turn 且 usage 合并、edit newText+遮蔽叠加、五种预检、遮蔽不跨 turn）+
   `tests/gateway/rewrite-last-turn-protocol.spec.ts`（3：守卫接受/拒绝、Gateway
   optional 断言），共 7 case；discovery-protocol allowlist 加 "1.7"。

## Alternatives considered

- **物理删除/原地修改 transcript 条目** — 落选；破 append-only 纪律，resume 重放、
  审计链、工具结果 spill 文件的 turnId 关联全部失锚。遮蔽指针是增量式变更，
  旧条目仍可被 TaskResumeScanner 等按原样消费（其只认 turn_result/request_header）。
- **`turn_rewritten` 广播事件** — 落选（对 PR 计划的偏离）；方法响应已携带
  rewritten/reason/shadowedEntryCount，UI 成功后走既有 turn 事件流 + complete 后
  服务端刷新即可感知结果，额外事件只增加事件矩阵面与双写时序风险。
- **chat.js 拆「edit 帧 + 独立 submit 帧」两帧** — 落选；ws `on("message")` 每帧
  独立 async handler、帧间不互斥，await yield 后两帧竞态（submit 可能先于 shadow
  落盘读取历史）。必须在单帧内串行 shadow → submitTurn。
- **UI 编辑走独立内联编辑框（inline textarea 替换消息行）** — 落选；composer
  prefill 模式复用既有输入路径（附件/slash/草稿逻辑零新增），与 fork 的
  prefillText 范式一致，交互心智负担更低。
- **客户端本地剔除被遮蔽消息** — 落选；complete 后 `refreshSessionFromServer`
  以服务端投影为准自然收敛，本地剔除要与流式状态机同步，徒增竞态面。

## Consequences

- 网关协议升至 1.7（MINOR，向后兼容；旧客户端不感知新方法，旧服务端
  `not_configured` 兜底为 `{rewritten: false}` → UI toast）。
- 事件矩阵无新增事件行（方法级响应，无新 AgentEvent）；已 `pnpm gen:event-matrix`。
- 不改任何工具 `inputSchema`/`outputSchema`，LLM replay fixtures 不受影响。
- `turn_rewrite` 条目对 `TaskResumeScanner`/`findOpenRequest` 透明（其只认
  request_header/turn_result/消息条目，扫描自然跳过遮蔽指针）。
- 已知限制：compact 边界之前的 turn 不可改写（`compact_tail` 拒绝）；带附件/图片的
  user 消息不可编辑（`unsupported_content`）；运行中/挂起审批时不可改写。
