# Agent Note: Mid-turn steering（协议 1.6）

Status: implemented

## Problem

用户在 agent turn 运行中想补充指示时只有两种选择：排队等当前 turn 结束、或 abort 后
重发。两者都打断思路；上游 PilotDeck 已提供 mid-turn steering（插话注入），Sati 作为
同源 fork 需要等价能力：向运行中的 turn 投递一条补充指示，不打断当前工具执行，在
下一次模型调用边界进入上下文。

## Decision

1. **引擎层（排队注入，不中断 turn）**：
   - `src/agent/session/SteerMailbox.ts`：`SteerItem`/`SteerSource` 窄接口；`start(turnId)`
     开闸、`enqueue(text)` 入列（open 且 <16 项，超量返回 null 不阻塞）、`cancel(steerId)`
     墓碑撤回、`drain()` 取走即消费、`drainOrClose()` 收尾排空。同步无锁，靠事件循环
     串行化。
   - `src/agent/loop/steer.ts`：`steerPreview`（单行化 + 160 截断）、`buildSteerMessage`
     （user 消息，`metadata.purpose: "steer"` + `steerId`；**不标 synthetic/transient**——
     插话是用户真实输入，标 synthetic 会被 Web 投影过滤）。
   - `AgentLoop.run` 主循环在 `runTurnGuards` 之后、`prepareModelCall` 之前
     `applySteeredMessages`：drain → 先 `onDurableMessage` 落库（失败即中止注入，持久
     边界优先）→ push `state.messages`（尾部追加，不破坏 prompt-cache 前缀）→ 广播
     `steer_applied`。
   - `AgentSession`：options 注入 `steerMailbox`（默认自建）；`submit` 开头 `start(turnId)`；
     收尾 `drainOrClose()` 对残留项广播 `steer_unapplied`（reason ∈
     turn_ended/turn_aborted/turn_failed）；expose `steer()`/`cancelSteer()`/
     `pendingSteerItems()`。子代理经 `SubAgentSession.cloneDependencies` 显式字段列举，
     天然不继承 `steerSource`。
2. **协议层（1.6，MINOR）**：`steer_turn`/`cancel_steer` 方法 + `steer_applied`/
   `steer_unapplied` 事件；`Gateway` 接口 optional 方法（`steerTurn?`/`cancelSteer?`），
   旧实现 feature-detect + `not_configured` 兜底；`ActiveTurnSnapshot` 加 `steerItems?`
   快照；版本表 1.6 条目。
3. **UI 层**：composer busy 排队条新增第三选项——「插话」（`steer-session` 帧，仅纯文本
   无附件时可用）：`sati-bridge.js` `steerViaGateway`（feature-detect `gw.steerTurn`）→
   `websocket/chat.js` `steer-session` 分支 → `useChatComposerState.steerBusySendQueue`
   → `ComposerV2` busy inline 条按钮。与既有排队（等 turn 结束）/二次确认 abort 并存。
4. **测试**：`tests/agent/session/steer-mailbox.spec.ts`（6）、
   `tests/agent/session/steer-session.spec.ts`（4）、
   `tests/agent/loop/steer-injection.spec.ts`（4）、
   `tests/gateway/steer-protocol.spec.ts`（3），共 17 case。

## Alternatives considered

- **注入即中断当前模型流**（立即重发请求）— 落选；浪费已生成的 token 与工具执行，
  且与 PilotDeck 上游语义（下一次模型调用边界）不一致，事件时序也更难测。
- **插话标 `synthetic: true`** — 落选；Web 消息投影按 synthetic 过滤，用户会看不到
  自己发的插话。
- **turn 结束时残留插话项落库为普通消息、下一 turn 开头投递** — 落选；turn 已结束
  再注入语义错位（用户指的是"现在的执行"），静默投递还会制造上下文突变。选择仅广播
  `steer_unapplied` 提示，由 UI 决定如何告知用户。
- **steer 走独立 mailbox 进程/队列组件** — 落选；单 turn 内单写者（gateway 投递线程）
  单读者（loop drain），同步类即可，无锁靠事件循环串行化足够。
- **UI 插话支持附件** — 落选；插话语义是"一句话补充指示"，附件走排队/abort 路径。

## Consequences

- 网关协议升至 1.6（MINOR，向后兼容；旧客户端忽略新事件、旧服务端 `not_configured`）。
- 事件矩阵新增 `steer_applied`/`steer_unapplied` 两行（已 `pnpm gen:event-matrix`）。
- 不改任何工具 `inputSchema`/`outputSchema`，LLM replay fixtures 不受影响。
- `TaskResumeScanner` 不涉及：插话不落形态断点（经 `onDurableMessage` 正常落库）。
