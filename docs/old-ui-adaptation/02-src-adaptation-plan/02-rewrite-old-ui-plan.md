# 重写或改写 old_ui 的方案

本文描述如何改写 `old_ui/`，使它逐步适配 PilotDeck `src/`。目标不是一次性大爆炸重写，而是用 adapter 分层把旧 UI 从旧 Express/provider 后端迁到 Gateway。

## 目标形态

目标 Web UI 分层：

```text
Web React UI
  -> web data hooks
  -> GatewayBrowserClient / WebApiClient
  -> PilotDeck Gateway / Web Adapter
  -> src/agent + src/session + src/tool + src/model + src/cron
```

旧的这些依赖应逐步退出主路径：

- `old_ui/server/index.js` 中聊天 provider command 分发。
- `old_ui/server/providers/*` 作为主消息来源。
- Web UI 对 Claude/Cursor/Codex/Gemini 特定命令名的直接依赖。
- session 历史读取中的 provider 私有路径。

## Phase 0：冻结旧行为

先不动功能，补齐迁移所需的事实清单：

- 固化 `Project`、`ProjectSession`、`NormalizedMessage` fixture。
- 为 `/api/projects`、`/api/sessions/:id/messages`、`/ws` 关键事件建立 contract fixture。
- 记录 localStorage key 和默认值。
- 记录每个 tab 的最小可用流程。

产出：

- legacy contract fixtures。
- old-to-new event mapping 表。
- 迁移状态矩阵，每个能力明确状态。

## Phase 1：新增 PilotDeck Gateway Client

在 Web UI 内新增 PilotDeck client，不替换所有页面：

- 复用或扩展 `ui/src/gateway-browser-client.ts` 的协议实现。
- 支持 `hello_ok`、`response`、`event` 三类帧。
- 支持 `submit_turn` 的 event stream。
- 支持 `list_sessions/new_session/resume_session/close_session/abort_turn`。
- 以 `final: true` 结束 stream，不把 final 合成事件重复渲染成 assistant 消息。

同时新增消息适配层：

```text
GatewayEvent -> NormalizedMessage[]
```

示例映射：

- `assistant_text_delta` -> `stream_delta`
- `assistant_thinking_delta` -> `thinking`
- `tool_call_started` -> `tool_use`
- `tool_call_finished` -> `tool_result`
- `permission_request` -> `permission_request`
- `turn_completed` -> `complete`
- `error` -> `error`

## Phase 2：迁移 Chat 主流程

把 Chat 页面从 provider command 切到 PilotDeck Gateway：

- 新增 `pilotdeck` provider 或把 provider selection 抽象成 `runtime`.
- 发送消息时调用 `submit_turn`，传入 `sessionKey`、`channelKey: "web"`、`projectKey`、`message`、`mode`、`attachments`。
- 中断调用 `abort_turn`。
- 历史消息从新的 session messages API 读取，而不是 provider adapter。
- 权限模式映射到 Gateway `mode`：`default`、`plan`、`acceptEdits`、`bypassPermissions`。

保留旧 UI 体验：

- 流式文本不丢 delta。
- 工具调用有 started/finished 两段状态。
- 权限请求阻塞时显示 banner。
- session 创建后 URL 和侧边栏同步更新。

## Phase 3：迁移 Projects 与 Sessions

把项目和会话数据从旧 `/api/projects` 逐步迁到 Web adapter/Gateway：

- `projectKey` 应稳定表示项目根目录或项目 id。
- `sessionKey` 应稳定表示 PilotDeck session。
- 列表中保留 `title/summary/lastActivity/messageCount`。
- 背景任务 session 独立展示。

兼容方式：

- 短期：旧 `/api/projects` 返回 `pilotdeck` provider 的 sessions。
- 中期：新增 `/api/web/projects` 或 Gateway 方法。
- 长期：删除 provider-specific session lists。

## Phase 4：迁移 Files、Git、Shell

Files：

- 先把旧 file tree/read/write API 包成 workspace-safe service。
- 再将 UI hooks 从 `api.readFile/saveFile/getFiles` 切到新 client。
- 文件修改要与 PilotDeck tool/runtime 的工作区边界一致。

Git：

- status/diff/commit/pull/push 先以 service 暴露。
- 未来可将 Git 操作复用为 tool，但 Web UI 需要结构化响应，不要解析 shell 文本。

Shell：

- 初期可保留旧 `/shell` WebSocket。
- 新终端协议准备好后迁移为 Gateway terminal extension。
- provider CLI shell resume 逻辑不应成为 PilotDeck Chat 的主路径。

## Phase 5：迁移 Cron、Always-On、Settings

Cron：

- UI 列表映射到 `cron_list`。
- 创建映射到 `cron_create`。
- 删除映射到 `cron_delete`。
- 停止映射到 `cron_stop`。
- run now、history、log 需要 `src` 补接口。

Always-On：

- Discovery trigger 和 plan list 应对齐 `src/always-on`。
- 后台执行 session 与 transcript 必须可跳转。

Settings：

- provider/model 设置迁移到 PilotDeck config。
- 权限 allow/deny/ask 迁移到 `PermissionConfig`。
- UI 偏好继续 localStorage，但使用 `pilotdeck.*` key。

## 删除旧后端的条件

只有满足以下条件，才应删除旧 Express/provider 主路径：

- Chat、session list、message history、abort、permission request 已通过 Gateway contract 测试。
- Files/Git/Shell 至少有明确替代或被标记为 deferred。
- Cron/Always-On 的新接口覆盖旧 UI 中承诺保留的用户流程。
- 旧 provider session 历史有迁移或只读兼容方案。
- 真实环境 runbook 能完成冷启动、基本 turn、工具调用、会话恢复和页面刷新。
