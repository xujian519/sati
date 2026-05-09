# PilotDeck Adapter / Gateway 单测维护与行为一致性文档

本文用于维护 PilotDeck `gateway` 与 `adapters/` 重构相关的单元测试、集成测试与（未来可能的）协议互操作测试。配套开发设计见：

- `docs/pilotdeck-adapter-refactor-development-guide.md`

本模块的特殊点：`third-party/claude-code-main` 没有 gateway / adapter 概念，因此本文档**不进行经典 legacy parity**。`compare` 状态在本模块的含义是“PilotDeck 在不同传输形态（in-process vs over-WS）下行为一致”，以及“与 `Gateway` 接口契约一致”。结构参考来自 `~/edgeclaw-opc/openclaw`，但只参考形态，不复制其复杂度。

## 1. 术语

- `Contract parity passed`：`InProcessGateway` 与 `RemoteGateway` 对同一组输入产出相同的事件序列与最终状态。事件流必须 deepEqual（在归一化后），不允许只比较“事件类型集合”。
- `Transport-symmetric`：同一 channel 业务代码在 in-process 与 over-WS 模式下，行为不可区分（含错误码、abort 时机、idle 行为）。
- `Deferred`：能力已规划但当前阶段不实现，对应 fixture 标记 `status: "deferred"`，必须有 reason。
- `Intentional difference`：新行为有意区别于 OpenClaw 等参考实现，必须记录 reason、risk、release review 要求。
- `Not applicable`：能力不在 PilotDeck 范围（如多设备、远程、launchd 自启动）；测试矩阵不覆盖。

禁止：

- 只跑 in-process 单测就声称 RemoteGateway 行为一致。
- 在测试中归一化掉 sessionKey、runId 等会影响业务路由的字段。
- 把 `transport-symmetric` 测试改成 mock RemoteGateway 直接调用 InProcessGateway——必须真实跑 WS 协议帧。
- 把权限请求事件、abort 时机这种语义差异归一化掉。

## 2. 测试分层

```text
protocol tests
  -> session router tests
  -> in-process gateway tests
  -> ws frame tests
  -> ws server connection tests
  -> remote gateway tests
  -> transport-symmetric parity tests
  -> channel adapter tests
  -> end-to-end integration tests
```

底层测试禁止启动真实 server；端到端测试禁止 mock 协议帧。

## 3. 测试命名规则

```text
tests/gateway/
  protocol-types.test.ts
  protocol-frames.test.ts
  session-router.test.ts
  session-router-concurrency.test.ts
  session-router-idle-recycle.test.ts
  in-process-gateway.test.ts
  in-process-gateway-stream.test.ts
  ws-frame-roundtrip.test.ts
  ws-server-connection.test.ts
  ws-server-auth.test.ts
  ws-server-static-assets.test.ts
  remote-gateway.test.ts
  remote-gateway-stream.test.ts
  remote-gateway-error.test.ts
  parity-transport-symmetric.test.ts
  probe-server.test.ts

tests/adapters/
  channel-cli.test.ts
  channel-cli-fallback.test.ts
  channel-tui.test.ts
  channel-feishu.test.ts
  channel-feishu-session-mapper.test.ts

tests/integration/
  server-cli.e2e.test.ts
  server-tui.e2e.test.ts
  server-feishu.e2e.test.ts
  server-shutdown.e2e.test.ts

tests/fixtures/gateway/
  transport-parity/
    submitTurnScenarios.ts
    abortScenarios.ts
    sessionLifecycleScenarios.ts
  scripted/
    gatewayScripts.ts          mock 后端的 SessionRouter / AgentSession

tests/helpers/
  gateway.ts                   createInProcessHarness / createWsHarness / createServerWithEphemeralPort
  channel.ts                   collectEvents / asyncIterToArray
  feishu.ts                    fakeFeishuWebhookEvent
```

当前已落地：

- `tests/gateway/session-router.test.ts`：覆盖 sessionKey 缓存、同 session 并发拒绝、idle 回收。
- `tests/gateway/in-process-gateway.test.ts`：覆盖 `AgentEvent` → `GatewayEvent` 基础文本流映射，以及 `session_busy` 错误。
- `tests/gateway/remote-gateway.test.ts`：起真实 GatewayServer，通过 `GatewayWsClient` + `RemoteGateway` 验证流式事件跨 WS 传输。
- `tests/adapters/channel-cli.test.ts`：覆盖 CLI argv 输入、sessionKey 推导和事件渲染。
- `tests/adapters/channel-tui-reducer.test.ts`：覆盖 TUI REPL reducer 对 assistant/tool 事件的 Claude Code 风格渲染状态映射。
- `tests/adapters/channel-feishu-session-mapper.test.ts`：覆盖飞书 general session 与 `/new` 切换规则。
- `tests/pilot/config/gateway-config.test.ts`：覆盖 `gateway` / `adapters` 配置解析。

尚未落地：完整 transport-symmetric fixture、Ink render snapshot、飞书 webhook 签名与 edit_message 节流测试、server-cli 子进程级 e2e。

## 4. 必须覆盖的事件序列

`Gateway.submitTurn()` 的事件流不可乱序；测试断言时必须保留全序列（不允许 `expect(events).toContain(...)` 取代序列比较）。

最小必须覆盖序列：

```text
turn_started
[ assistant_thinking_delta? ]
[ assistant_text_delta * ]
[ tool_call_started -> tool_call_finished ] *
[ permission_request -> （decision via separate method）]?
[ structured_output | plan_mode_changed ]?
turn_completed
```

在以下场景必须有专项测试：

- 纯文本回复，无 tool。
- 单个 tool call。
- 多个 tool call 串行（顺序 = 模型 emit 顺序）。
- tool_call_started 之后 abort：必须收到 `error/recoverable=true` 然后 `final`，不允许悬挂 `tool_call_finished`。
- 权限拒绝：`permission_request` → 用户拒绝 → `tool_call_finished/ok=false` → `turn_completed`。
- 模型错误：`error/recoverable=true` 后 turn 走 fallback；不可恢复错误：`error/recoverable=false` + `final: true`。
- session 已 busy 时再次 `submitTurn`：必须立即 `error/code: "session_busy"`，不进入 turn_started。

## 5. SessionRouter 必须覆盖

| Case | 行为 | 断言要点 |
| --- | --- | --- |
| 初次 sessionKey | 磁盘无 transcript → 新建 AgentSession | 调用 storage.create，返回的 session 有 sessionKey |
| 已存在 transcript | 自动 resume | 不重复创建；调用 storage.load |
| 同 sessionKey 并发 submitTurn | 第二次立即拒绝 | 错误码 `session_busy` |
| Idle 超时 | session 关闭，再次 submit 时重新加载 | 不丢 transcript；resume |
| 显式 close | 后续 submit 重建 | |
| abort 跨连接 | server 上一个 channel 触发 abort，另一连接收到 `error/recoverable=true` | |

## 6. WS 帧协议必须覆盖

- `WsHelloFrame` 缺 token / token 错误 / protocolVersion 不匹配 → 三种关闭码。
- `WsRequestFrame` 缺 method / 未知 method → `WsResponseFrame.ok: false` + `code: "method_not_found"`。
- `WsRequestFrame.params` schema 不合法 → `code: "invalid_params"`。
- `submit_turn` 流式：每个 `WsEventFrame.seq` 单调递增 +1；`final: true` 之后 server 不再发同 id 帧。
- 中途连接断开：client 必须在 reader 上抛 `connection_closed`；server 必须 abort 对应 turn。
- token 文件被删除 / 改写后再连：握手失败。

## 7. Transport-symmetric Parity

这是本模块替代“legacy parity”的核心机制。共享 fixture 在 `tests/fixtures/gateway/transport-parity/` 下，每个场景用同一份 mock SessionRouter 跑两次：

1. 通过 `InProcessGateway` 直接调用，收集 `GatewayEvent` 序列与 `submitTurn` 完成态。
2. 通过 `GatewayServer` + `RemoteGateway` 走真实 WebSocket 跑同一场景，收集事件序列。
3. 对两份输出做归一化（剥离 timestamps / runId / 内存地址），然后 deepEqual。

要求：

- 必须用真实 `WebSocketServer`（监听 ephemeral port，绑 127.0.0.1），禁止 mock。
- 必须用真实 ws 客户端（`ws` npm 包）。
- 测试退出前必须 close server 与所有连接，避免句柄泄漏。
- `runId` 由 InProcessGateway 与 RemoteGateway 协商生成，归一化时替换为 `RUN_ID_*`。

每个 `compare` 场景必须同时在两条路径下产出 deepEqual。任何路径下行为差异都必须重分类为 `intentional_difference` 并在 fixture 中记录原因。

## 8. Channel Adapter 测试

每个 channel adapter 测试必须用 fake gateway（满足 `Gateway` 接口的内存实现），断言两件事：

1. **输入翻译**：channel 收到外部输入后，调用 `gateway.submitTurn()` 的参数 deepEqual 期望值（含 sessionKey 计算结果）。
2. **输出渲染**：给定 `GatewayEvent` 序列，channel 产出的渲染结果（stdout 文本 / ink snapshot / 飞书 edit_message 调用列表）deepEqual 期望值。

CLI 专项：

- argv 模式 vs stdin 交互模式分别覆盖。
- `probeServer` 可达 → 期望使用 RemoteGateway；不可达 → InProcessGateway 且 stderr 提示一次。
- abort（`Ctrl-C`）→ 期望调用 `gateway.abortTurn`。

TUI 专项：

- `/new` / `/resume <id>` / `/sessions` 三个命令分别触发对应 `gateway` 方法。
- ink 渲染快照覆盖：thinking 折叠面板、tool call 卡片、错误状态条。

Feishu 专项：

- `FeishuSessionMapper` 覆盖：默认 → general；首次 `/new` → 生成 uuid 并持久化；再发普通消息 → 走新 sessionKey；再次 `/new` → 切到下一个 uuid。
- 节流逻辑：`assistant_text_delta` 高频到来时 edit_message 调用次数 ≤ ⌈stream_duration / 800ms⌉ + 1。
- 飞书 webhook 签名 / verify token 不匹配 → 拒绝处理。
- 单 chat 内多用户消息：不混淆 sessionKey。

## 9. End-to-End 集成测试

`tests/integration/server-*.e2e.test.ts` 必须：

- 在 ephemeral port 起真实 `pilotdeck server` 进程（spawn 子进程或同进程内 startGatewayServer + 注入 mock model）。
- 用真实 ws client / 真实 stdin 写入 / 真实飞书 webhook payload 模拟。
- 至少一个 case 跑完整 turn（mock model 返回包含 1 个 tool call 的脚本，tool 由内置 echo tool 执行）。
- 验证 transcript 真的写到磁盘（用临时 project root）。
- 关闭 server 时 client 收到 `connection_closed` 错误。

禁止用真实 OpenRouter / Anthropic / 飞书 API，model layer 与飞书 client 必须 mock。

## 10. 不在测试范围

- launchd / systemd / schtasks 自启动逻辑。
- 远程访问、TLS、设备配对。
- WhatsApp / Slack / iMessage / Discord channel。
- Canvas-host / browser extension bridge。
- Cron 的 runtime、tool 和 Gateway 管理面已由 `tests/cron/` 覆盖；Adapter 测试只需覆盖 WS method 转发和 CLI `pilotdeck cron` 命令形状。
- Model 反向代理（`proxy.ts` 类）。
- 跨进程 IPC（除 WebSocket 外）。

以上能力在 `docs/pilotdeck-adapter-refactor-development-guide.md §13 Feature Matrix` 标记为 `deferred` 或 `not_applicable`；Cron 不再属于 deferred 范围。

## 11. 归一化规则

允许归一化：

- 时间戳 → `TIMESTAMP_*`。
- runId → `RUN_ID_*`。
- 临时端口 → `PORT_*`。
- 临时项目路径 → `WORKSPACE_RELATIVE`。
- 飞书 message_id → `FEISHU_MSG_*`。

禁止归一化：

- sessionKey 实际值（这是路由关键）。
- 错误码（`session_busy` / `invalid_params` / `auth_failed` 等必须可见）。
- 事件类型与顺序。
- final 标记位置。
- 权限决定值。
- 飞书 edit_message 调用次数（这是节流断言基础）。

## 12. Validation Commands

```bash
npm run build
npm test
```

可选专项：

```bash
npm test -- tests/gateway/
npm test -- tests/adapters/
npm test -- tests/integration/
```

E2E 测试默认参与 `npm test`；CI 必须保证 ephemeral port 选取与子进程清理稳健。

## 13. 何时可以声称 parity passed

- 本模块对外只声明两类 parity：
  1. `Transport-symmetric`：仅当 `tests/gateway/parity-transport-symmetric.test.ts` 当 commit 全绿、覆盖 fixture 中所有 `compare` 场景，可声称 transport parity passed。
  2. `Contract`：仅当 `Gateway` 接口的所有方法均有 round-trip 协议测试通过，可声称 contract parity passed。
- 不得声称“与 OpenClaw 行为一致”，因为 PilotDeck 是 OpenClaw 协议的子集 + intentional differences。如未来需要互操作，需另立 `docs/pilotdeck-openclaw-interop-guide.md` 与对应 dual parity fixture。

## 14. 失败现场处置

- WS 测试 flake：优先排查端口冲突、句柄泄漏（vitest 输出 `--reporter=verbose --no-coverage` + `wtfnode`），不要直接 retry。
- 飞书节流测试 flake：检查 fake timer 是否完整覆盖 stream 全周期；禁止用真实 `setTimeout`。
- 集成测试 hang：必须有顶层 `test.timeout` 与 `afterEach` 强制 close server / kill child。
