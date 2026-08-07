# 浏览器直连聊天（P2b）设计草案

> 状态：草案（2026-08-05）｜前置：P0（协议协商 + alias + token 通道）、P1（只读方法双轨试点）已完成｜**P2b-0 已完成（2026-08-05）**

## 1. 背景与现状

**目标链路**：`前端 Chat → GatewayBrowserClient.stream("submit_turn") → ws://127.0.0.1:19789/ws → GatewayWsConnection（已支持流式分发）→ InProcessGateway`

**已核实事实**：
- 服务端：`GatewayWsConnection` 已支持 `submit_turn` 流式分发（`event` 帧带 `seq`/`final`）；`active_turn_snapshot` 已实现（返回 `{ active, sessionKey, runId?, events, truncated? }`）；`permission_decide` / `elicitation_respond` / `abort_turn` 协议方法齐备；
- 客户端：`GatewayBrowserClient` 已具备 `stream`（`AsyncEventQueue`）/ `submitTurn` / `abortTurn` / `request`；断线重连**未内置**（`connect()` 只做一次性握手）；
- 前端现状：**不消费 `WebGatewayEvent`**——`useChatRealtimeHandlers` 消费 ui/server 归一化后的消息模型（`kind: text/stream_delta/thinking/status` + `role` + `sessionId`）；权限弹窗由 `useChatComposerState` 发 `permission-response` 帧经 ui/server 中转；
- ui/server 中转层价值：① 事件归一化（`createNormalizedMessage`）；② `session-watch-registry` 多标签页广播；③ "turn outlive browser ws"（agent 在标签页关闭后继续跑，事件不丢）；④ 权限/elicitation 编排。

## 2. 前置问题一：断线续传（snapshot 恢复）

### 2.1 语义设计

消息状态与流状态分离：
- `useChatMessages` 状态 = transcript 基础（磁盘，最终一致）+ 实时事件增量（内存）；
- 重连后以 `active_turn_snapshot` 为"权威增量"，reducer 按事件 id 幂等应用，**不重置已有消息**。

### 2.2 连接状态机

```
connected ──ws close──▶ reconnecting ──重连成功+hello──▶ snapshot_fetching ──▶ connected
   │                        │                                  │
   └── hello 失败重试 ──────┘         snapshot.active=false ──▶ 结束（transcript 为最终态）
```

### 2.3 恢复流程

1. ws `close` → 前端置 `connectionState=reconnecting`，保留现有消息 + 活跃流队列；
2. 重连（`connect()`）成功 → 对每个活跃会话并发发 `active_turn_snapshot`；
3. `snapshot.active=true` → 将 `snapshot.events` 逐条喂给归一化 adapter（见 §5），按 `(runId, seq)` 去重；`truncated=true` 时只恢复尾部窗口并提示；
4. `snapshot.active=false` → 走 transcript 全量刷新；
5. 恢复完成 → 移除 reconnecting 横幅，继续消费实时流。

### 2.4 UX 语义

- 断线横幅：`reconnecting…（正在恢复 X 个会话）`；恢复成功自动消失；
- 用户无感恢复：不需要手动 reload；
- `truncated` 兜底：提示"运行中，部分历史未加载"，提供「从 transcript 重新加载」操作；
- 关闭标签页场景（原 "turn outlive browser" 保证）：turn 在 gateway 侧继续（协议不变），**重新打开任意标签页 → transcript 已有最终态**；仅当同一标签页断线后希望"追回中间过程"时依赖 snapshot。

## 3. 前置问题二：多标签页同步

### 3.1 方案对比

| 方案 | 实时性 | 正确性保证 | 服务端负担 | 结论 |
|---|---|---|---|---|
| A. BroadcastChannel 广播 | 发起 tab 转发归一化消息 | 弱（仅实时增量） | 无 | **主方案** |
| B. 保留 ui/server watch 通道 | 强（服务端广播） | 强 | 中转未退役 | 弃用 |
| C. 各 tab 独立直连 + transcript watcher | 中（文件事件延迟） | 强（磁盘最终一致） | 无 | 兜底 |

### 3.2 推荐：A 主 + C 辅

- **实时镜像（A）**：发起 turn 的标签页把归一化后的消息经 `BroadcastChannel("sati-chat-<sessionId>")` 广播；其他标签页合并展示；
- **正确性兜底（C）**：任何标签页（含新打开）主动 `read_session_messages` 全量拉取 + `active_turn_snapshot` 补实时——多标签页一致性**不依赖**广播，广播只是加速；
- **退役**：ui/server `session-watch-registry`、`watch-session` 帧、`broadcastToSessionWatchers` 全部移除。

### 3.3 边界

- 跨浏览器 profile / 隐身窗口：BroadcastChannel 不通，降级为 C（正确性不受影响）；
- 同源要求：BroadcastChannel 天然同源，满足（`ws://127.0.0.1` 与页面同源）。

## 4. 前置问题三：权限 / elicitation 前端状态机

### 4.1 状态机（per-request）

```
permission_request / elicitation_request
        │ 入队（requestId → pending）
        ▼
    pending ──用户决策──▶ decided ──发送协议帧──▶ sent ──await ack──▶ done
        │                                                          │
        ├──elicitation_cancelled ──▶ cancelled（出队）             │
        └──断线（stale 标记）────────────▶ 重连后按 snapshot 状态重判 ─┘
```

### 4.2 交互

- `permission_request` → 复用现有弹窗 UI（`useChatComposerState` 的 permission 面板抽为 `PermissionDialog`），决策后发 `client.request("permission_decide", { requestId, decision, remember, reason })`（协议方法已存在）；
- `elicitation_request` → 表单弹窗（复用现有 `elicitation` 渲染），提交发 `client.request("elicitation_respond", { requestId, answers })`；
- `elicitation_cancelled` / `error` → 出队并关闭弹窗；
- **断线策略**：pending 队列标记 `stale`，重连后若 snapshot 仍含该 `requestId` 则重新呈现；否则视为已失效（gateway 侧已处理）。

### 4.3 与现有代码关系

- `useChatComposerState.ts:1453` 的 `permission-response` 帧发送路径删除；
- `decidePermissionViaGateway` / `abortViaGateway` 在 ui/server 的适配层退役（直连后由前端直发协议帧）。

## 5. 隐含前置：事件归一化 adapter（P2b-0，必须先做）

前端不消费 `WebGatewayEvent`，直连后需要一层适配：

```
WebGatewayEvent ──▶ webEventToChatMessage(event, sessionId) ──▶ 前端消息模型
  assistant_text_delta      → kind:"stream_delta"
  assistant_thinking_delta  → kind:"thinking"
  tool_call_started/finished→ tool 行（含 images → dataURL）
  permission/elicitation    → 状态机输入（§4）
  turn_started/completed/error → status 帧
```

- 实现为**纯函数模块** `ui/src/chat/gatewayEventAdapter.ts`（可单测，无 React 依赖）；
- 与 ui/server `createNormalizedMessage` 的输出语义对齐，使现有 `useChatRealtimeHandlers` 的合并/去重逻辑**原样复用**；
- 明确**不引入** `src/web/client/webMessage.ts` 的 `applyWebGatewayEvent`——它是另一套模型，避免双轨。

## 6. 落地顺序与验收

### 进度

| 阶段 | 状态 | 验收结果 |
|---|---|---|
| P2b-0 | ✅ 已完成 | `ui/src/chat/gatewayEventAdapter.ts`（纯函数，无 React/服务端依赖）+ `gatewayEventAdapter.test.ts` 24 用例全绿；映射表覆盖全部顶层事件类型 + agent_status 五个子分支；tsc/eslint/biome 通过；语义来源为 sati-bridge `gatewayEventToFrames`（对齐 createNormalizedMessage 输出形状） |
| P2b-1 | ✅ 已完成 | `ui/src/chat/usePermissionQueue.ts`（纯 reducer 状态机 + hook，sender 注入支持双轨）+ 10 用例全绿；`api.js` 新增 `gatewayPermissionDecide` / `gatewayElicitationRespond` 协议直发（permission_decide / elicitation_respond 输入对齐 Gateway 协议类型）；`permission-response` ws 帧路径删除**推迟到 P2b-3 双轨切换时**（现网聊天仍依赖该路径，提前删会破坏运行中功能） |
| P2b-2 | ✅ 已完成 | 协议层增强：`GatewayBrowserClient` 区分用户 close 与意外断线，新增 `onDisconnect` / `reconnect()`（reconnecting 标志抑制误触发，`gatewayReconnect.test.ts` 4 用例）；`ui/src/chat/useReconnect.ts`（connection 抽象解耦 + runningRef 防并发 + 断线自动恢复/手动 retry，`useReconnect.test.ts` 5 用例）。**实现语义修订**：恢复由草案的“按 (runId, seq) 逐条去重”改为**按 runId 重置式全量重放**——snapshot.events 无 seq 字段，逐条去重需内容指纹（脆弱）；重置由调用方 replayEvents 承担（P2b-3 接线时按 runId 重置实时增量），无重复由重置保证、无丢失由 snapshot 全量保证 |
| P2b-3 | ✅ 已完成 | `gatewayChatMapper.ts`（sati-command/abort-session/permission-response/elicitation-response → 协议调用，10 用例）；`useGatewayDirectChat.ts`（WebSocketContext 等价实现：sendMessage 映射 + submitTurn 流→adapter→广播 + 断线自动重连，5 集成用例 mock ws 全流程）；`WebSocketContext` 双轨开关 `VITE_GATEWAY_DIRECT_CHAT=1`（Provider 拆为 Legacy/Direct 两组件，Chat 组件零改动）；`api.js` 导出 `getGatewayClient`。**收尾接线（断线恢复补齐）**：接入 `useReconnect`（onDisconnect → 自动 reconnect → 活跃会话取 `active_turn_snapshot` 全量重放，onRecovered 后移除活跃标记）；`runTurn` 断线保留语义——`AsyncEventQueue.fail` 对挂起 waiter 用 `done:true` 静默结束（for await 正常退出不抛错），故以 `client.connected` 区分正常完成/断线中断（断线保留活跃标记交恢复接管）；异步 client 初始化下断线订阅用 pending 队列补注册；`clientReady` state 驱动 isConnected（ref 赋值不触发重渲染）；暴露 `retryReconnect` 供 UI 手动重试（自动 recover 失败后保持 reconnecting）。**已知限制（记录）**：不做并发 turn 排队（gateway 侧行为决定） |
| P2b-4 | ✅ 已完成 | `gatewayBroadcast.ts`（BroadcastChannel 封装：post 不回传自身、订阅/取消，3 用例）；`useGatewayDirectChat` 集成跨标签页镜像（本地 broadcast + 广播订阅，多标签页集成用例：A 发起 turn → B 实时收到镜像，B 不经 ws 流）；**多标签页验收主项达成**（双标签页同会话实时镜像；各标签页独立连接/独立断线，天然隔离）。**watch 通道退役推迟**：`session-watch-registry` / `watch-session` 帧 / `broadcastToSessionWatchers` 仍被 Legacy（非直连）模式使用（默认开关未切换），删除会破坏现网聊天——待直连成为默认（P3）后一并退役；`permission-response` 旧路径同理保留 |

### 验收标准

| 阶段 | 内容 | 验收 |
|---|---|---|
| P2b-0 | `gatewayEventAdapter.ts` + 单测（事件→消息模型全映射表） | 新增单测覆盖全部事件类型；`useChatRealtimeHandlers` 无需改动即可消费 adapter 输出 |
| P2b-1 | 权限/elicitation 直连：`usePermissionQueue` + 协议帧直发，UI 复用 | 弹窗/决策/取消全链路走 gateway 协议；`permission-response` 帧路径删除；单测覆盖状态机 |
| P2b-2 | 重连状态机：`useReconnect`（reconnecting/snapshot_fetching）+ 幂等恢复 | 断线重连后消息无重复/无丢失（集成测试用 mock ws 模拟断线）；横幅语义正确 |
| P2b-3 | `submit_turn` 主链路切换（双轨：`VITE_GATEWAY_DIRECT_CHAT=1` 走直连，默认仍走 ui/server） | 直连模式下聊天全流程可用；切回开关零回退 |
| P2b-4 | 多标签页：BroadcastChannel 广播 + 独立恢复；退役 watch 通道 | 双标签页同会话实时镜像；单标签页断线恢复不影响另一标签页；`session-watch-registry.js` 删除 |

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 前端事件模型与 adapter 输出存在语义缝隙（乐观帧/状态机差异） | P2b-0 以"全事件类型映射表"单测锁死；对比 `createNormalizedMessage` 逐字段对齐 |
| snapshot 全量重放对长 turn 成本高 | `truncated` 窗口化 + 按 seq 去重；transcript 兜底 |
| 多标签页 BroadcastChannel 失效场景 | 降级为独立恢复（C），正确性不依赖广播 |
| 双轨长期共存导致行为分叉 | 每阶段验收后推进；P2b-4 完成后移除开关默认值改为直连 |
| gateway 重启导致 token/连接失效 | 复用 `getGatewayClient` 的失败重试 + token 重新领取（`resetGatewayClient` 已支持） |

## 8. 不做（本期明确排除）

- `applyWebGatewayEvent` 模型接入（与现有前端消息管线并存会造成双轨）；
- 聊天转录历史迁移 / transcript 格式改动；
- 非 sati 品牌（pilotdeck-bridge）的直连适配——chat 已仅支持 sati，pilotdeck 侧随后续版本退役。
