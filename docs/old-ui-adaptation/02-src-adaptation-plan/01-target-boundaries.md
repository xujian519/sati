# 目标适配边界

本文定义 Web UI 应该对接哪些 `src` 模块，以及哪些内部实现不应被 UI 直接依赖。

## 首选边界：Gateway

当前 `src/gateway` 是 Web UI 的首选运行时边界。原因：

- 它已经把 CLI、TUI、Feishu、Web、test 等入口抽象为 channel。
- 它以 request/event stream 表达 turn，适合浏览器实时渲染。
- 它把 session、abort、cron 和 server info 放在同一协议中。
- 它隔离了 `agent`、`model`、`tool`、`session`、`context` 的内部结构。

关键文件：

- `src/gateway/protocol/types.ts`
- `src/gateway/protocol/frames.ts`
- `src/gateway/server/GatewayServer.ts`
- `src/gateway/server/GatewayWsConnection.ts`
- `src/gateway/client/InProcessGateway.ts`
- `ui/src/gateway-browser-client.ts`

## Gateway HTTP Surface

当前 Gateway server 暴露：

- `GET /health`
- `GET /auth/local-token`
- `POST /feishu/webhook`
- 静态资源挂载

Web UI 可直接使用：

- `/auth/local-token` 读取本地 token。
- `/ws` 建立 Gateway WebSocket。
- 静态资源能力承载新 Web bundle。

不建议在第一阶段把旧 `/api/*` 全量搬到 Gateway server。应先建立必要的 Web adapter API，再逐步替代旧 API。

## Gateway WebSocket Surface

连接流程：

```text
WebSocket open
  -> hello(protocolVersion, clientName="web", clientVersion, token)
  <- hello_ok(protocolVersion, serverVersion, serverInfo)
  -> request(id, method, params)
  <- response 或 event stream
```

方法：

- `submit_turn`
- `abort_turn`
- `list_sessions`
- `resume_session`
- `new_session`
- `close_session`
- `describe_server`
- `cron_create`
- `cron_list`
- `cron_delete`
- `cron_stop`

事件：

- `turn_started`
- `assistant_text_delta`
- `assistant_thinking_delta`
- `tool_call_started`
- `tool_call_finished`
- `permission_request`
- `structured_output`
- `plan_mode_changed`
- `turn_completed`
- `error`

## Session Boundary

Web UI 不应直接解析 transcript 文件路径。它应通过 Gateway 或 Web adapter 调用：

- list sessions
- new session
- resume session
- close session
- read transcript replay

`src/session` 是 transcript 和恢复事实来源。UI 可以缓存渲染结果，但不能把 localStorage 或 React state 当作会话事实来源。

需要补齐的边界：

- `read_session_messages` 或等价 HTTP/Gateway 方法。
- 分页/cursor 语义。
- session title/summary/lastActivity/messageCount 的稳定 DTO。
- 背景任务 session 与普通 session 的类型区分。

## Config Boundary

Web UI 不应拼接或读取 `~/.politdeck/politdeck.yaml`。它应通过 `src/polit/config` 的服务接口获得：

- 当前生效 model/router/tool/permission/session/extension 配置摘要。
- 可编辑配置段和只读诊断结果。
- env override 造成的只读字段。

涉及文件：

- `src/polit/config/loadPolitConfig.ts`
- `docs/polit-config/`

旧 UI 的 EdgeClaw YAML/env 派生配置应被收敛到 PolitDeck config 文档和 schema 中，避免继续由 Web server 私有解析。

## Cron 与 Always-On Boundary

Gateway 已有 `cron_create/list/delete/stop`。Web UI 应优先使用这些方法。

需要补齐：

- run now 或 trigger now。
- run history list/detail/log。
- Always-On discovery 状态、计划、执行 session 关联。
- Project 维度的 cron/always-on summary。

这些能力应归入 `src/cron`、`src/always-on` 和 Gateway 管理面，而不是复用旧 UI 后端的 cron daemon 私有接口。

## File、Git 与 Shell Boundary

旧 UI 的 Files、Git、Shell 是 Web IDE 体验的重要组成，但当前 `src/gateway` 还没有完整 Web 文件管理和终端协议。

建议：

- Files：先通过 Web adapter 暴露受 workspace root 限制的 file tree/read/write/create/rename/delete/upload。
- Git：通过 `src/tool` 或专门 Git service 暴露 status/diff/branch/commit/pull/push，不让前端自由执行 shell。
- Shell：短期可保留旧 `/shell` 协议作为 legacy adapter；中期设计 `terminal_open/input/resize/close` Gateway extension。

禁止：

- React 组件直接 import `src/tool/builtin/bash`。
- 浏览器端拼接绝对路径绕过 workspace root。
- Web UI 自行解析 transcript JSONL 作为事实来源。
