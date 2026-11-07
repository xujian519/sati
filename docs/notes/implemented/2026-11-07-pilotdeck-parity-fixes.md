# Agent Note: PilotDeck 2026-11 parity 八项小修

Status: implemented

## Problem

对照上游 `v2026.10.20..v2026.11.07` 的 355 个非 merge 提交，Sati 在同一段代码上复现了 8 个低风险缺陷：

1. 多模态配置只写 `input` 时，未提供的字段被显式赋 `undefined`，抹掉 catalog 默认值。
2. 记忆库连接只有 WAL，没有 `busy_timeout`；并发写第二个连接立即 `SQLITE_BUSY`。
3. 历史回放只保留 plan/search payload，`ask_user_question` 的 questions/answers 刷新后丢失。
4. 主代理工具集缺少 `agent`/`task` 时被误判为子代理，改变路由与 token 预算。
5. 输出 token 重试在没有可用 bump 时也消耗一次性额度，后续恢复轮静默跳过 Phase A。
6. MCP 启动抛出非 `Error` 值时，状态条目出现 `undefined` 或丢失原始消息。
7. `NetworkFetchError` 的 `network_fetch_failed`/`network_abort` 没有对应错误码；cause 中的网络错误不参与分类。
8. 上下文恢复失败且没有 `CanonicalModelError` 时，指引退回「检查 base URL/API key」。

## Decision

- 多模态解析先收集用户显式字段，再 `{ ...defaults, ...overrides }`。
- 记忆库 `init()` 首行设置 `PRAGMA busy_timeout = 5000`。
- 历史回放识别 `ask_user_question` / `AskUserQuestion`，把 `data` 放进 `payload`。
- `isSubagent = !isMainAgent || taggedInUserMessage`；`missingAgentTool` 保留为诊断字段。
- `hasAttemptedOutputRetry = true` 移入「确实拿到新上限」分支。
- 新增 `describeThrown()`；MCP 连接与运行时都用它归一任意抛出值。
- `CanonicalModelErrorCode` 增加 `transport_error` / `aborted`；网络分类支持 cause 递归、`AbortError` 与 `fetch failed` 文本；`transport_error` 可重试，`aborted` 不重试。
- `modelFailureAction()` 接受 error code；无 `modelError` 且 code 为 `agent_context_recovery_failed` / `agent_prompt_too_long` 时使用上下文溢出指引。

## Alternatives considered

- **只改 `McpRuntime`，不改连接层。** 落选。非 `Error` 抛出在 `connection.ts` 已被包装成 `MCP handshake failed: undefined`，只在最外层改仍然丢失原始消息。
- **把 `missingAgentTool` 从返回值里删掉。** 落选。它是有效诊断信号，删掉会失去排查线索；改为不参与判定。
- **把非 Error 抛出统一成 `String(err)`。** 落选。`null`/`undefined` 会变成字面量 `"null"`/`"undefined"`，可读性差；`describeThrown` 给出 `"unknown error"`。
- **对 `fetch failed` 也按可重试网络错误处理。** 落选。普通 fetch 失败可能是请求构造错误；归为 `transport_error`（可重试）是上游口径，保留但只匹配明确的文本。
- **在 `ToolRuntime` 层统一 catch 输出重试标志。** 落选。额度语义属于恢复策略，放在调用方会散落。
- **本轮同时改 UI 展示。** 落选。八项都是后端正确性；UI 没有新增可见行为，避免扩大 PR 面。

## Consequences

- 每项都有定向测试与负控制；负控制结果记录在 PR 描述。
- `CanonicalModelErrorCode` 扩了两个成员，当前没有穷尽 switch 的消费者。
- `transport_error` 进入可重试列表，网络层普通失败会多一次重试机会。
- 未改工具 `inputSchema`、网关协议或事件名；`pnpm check` 与全量测试绿。
