# old_ui 数据、协议与状态

本文描述旧 UI 中最需要保护的协议形状。适配时应优先保证这些边界可被测试，而不是优先迁移页面代码。

## 项目数据

`Project` 是侧边栏、项目页和会话列表的基础模型：

```text
Project
  name
  displayName
  fullPath
  sessions
  cursorSessions
  codexSessions
  geminiSessions
  sessionMeta
  taskmaster
  alwaysOn
```

项目接口主要来自：

- `GET /api/projects`
- `GET /api/projects/:projectName/sessions?limit=&offset=`
- `PUT /api/projects/:projectName/rename`
- `DELETE /api/projects/:projectName`
- `POST /api/projects/create`
- `POST /api/projects/create-workspace`

迁移要求：

- `projectName` 与 `fullPath/projectKey` 的对应关系必须稳定。
- 会话分页必须保留 `total/hasMore/offset` 或等价 cursor。
- 旧 UI 允许一个项目同时有多 provider 会话；PolitDeck 可先收敛为单 provider，但响应中仍应保留来源字段，便于兼容旧渲染。

## 会话数据

`ProjectSession` 是列表项和聊天页的桥梁：

```text
ProjectSession
  id
  title / summary / name
  createdAt / created_at
  updated_at / lastActivity
  messageCount
  sessionKind
  parentSessionId
  relativeTranscriptPath
  transcriptKey
  taskId / taskStatus / outputFile
  isReadOnly
  __provider
  __projectName
```

背景任务 session 的关键字段是：

- `sessionKind: "background_task"`
- `parentSessionId`
- `relativeTranscriptPath`

这类 session 的消息读取必须带上背景任务参数，否则会读到父 session 或普通会话。

## 消息数据

旧 UI 的 `NormalizedMessage` 是聊天渲染核心：

```text
NormalizedMessage
  id
  sessionId
  timestamp
  provider
  kind
```

`kind` 包括：

- `text`
- `tool_use`
- `tool_result`
- `thinking`
- `stream_delta`
- `stream_end`
- `error`
- `complete`
- `status`
- `permission_request`
- `permission_cancelled`
- `session_created`
- `interactive_prompt`
- `task_notification`
- `interrupted`

历史消息接口：

```text
GET /api/sessions/:sessionId/messages?provider=&projectName=&projectPath=&limit=&offset=
```

返回语义：

- `messages`：归一化消息数组。
- `total`：总消息数。
- `hasMore`：是否有更早消息。
- `offset`、`limit`：分页状态。
- 可选 `tokenUsage`。

## REST API 形状

前端统一使用 `authenticatedFetch()`。默认会设置 JSON `Content-Type`，并在非平台、非免登录时携带：

```text
Authorization: Bearer <auth-token>
```

如果服务端返回 `X-Refreshed-Token`，前端会更新 `localStorage.auth-token`。

迁移时需要保留或显式替换这些接口族：

- Auth：`/api/auth/status`、`/login`、`/register`、`/user`、`/logout`。
- Projects/Sessions：项目列表、创建、删除、重命名、会话列表、会话消息、会话删除、会话重命名。
- Files：文件树、文件读取、保存、创建、重命名、删除、上传。
- Git：所有 `/api/git/*` 操作。
- Always-On/Cron：项目 cron jobs、run now、run history、log、discovery plans。
- Settings/Config：权限、模型、EdgeClaw 派生配置。

## WebSocket 协议

旧 `/ws` 不是标准 request/response 协议，而是命令和事件混合：

```text
frontend -> backend:
  { type: "claude-command", ... }
  { type: "cursor-command", ... }
  { type: "codex-command", ... }
  { type: "gemini-command", ... }
  { type: "abort-session", ... }

backend -> frontend:
  { type: "stream_delta", ... }
  { type: "permission_request", ... }
  { type: "session_created", ... }
  { type: "status", ... }
  { type: "complete", ... }
  { type: "error", ... }
```

新 `src/gateway` 的 `/ws` 是明确帧协议：

```text
hello -> hello_ok
request(method, params) -> response 或 event stream
event(id, seq, final, event)
```

迁移重点是建立适配表：

| 旧 UI 语义 | PolitDeck Gateway 语义 |
| --- | --- |
| `*-command` | `submit_turn` |
| `abort-session` | `abort_turn` |
| `session_created` | `new_session` / `resume_session` 结果或首个 turn 元数据 |
| `stream_delta` | `assistant_text_delta` |
| `thinking` | `assistant_thinking_delta` |
| `tool_use` | `tool_call_started` |
| `tool_result` | `tool_call_finished` |
| `permission_request` | `permission_request` |
| `complete` | `turn_completed` |
| `error` | `error` |

注意：`GatewayWsConnection` 当前在 `submit_turn` 流结束后额外发送 `final: true` 的合成 `turn_completed` 事件。Web UI adapter 应以 `final` 作为流结束标记，避免重复渲染完成消息。

## Browser State

旧 UI 使用较多 localStorage：

- `auth-token`
- `selected-provider`
- provider/model 选择 key
- `permissionMode-${sessionId}`
- `activeTab`
- `uiPreferences`
- `tasks-enabled`
- `theme`
- sidebar 宽度与折叠状态

适配建议：

- 与会话事实相关的数据不要继续只存在 localStorage。
- UI 偏好可以保留 localStorage。
- 模型、权限、provider 选择应尽量进入 PolitDeck config 或 Gateway session input。
- 历史兼容期可以读取旧 key，但新写入应使用 `politdeck.*` 命名空间。
