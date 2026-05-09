# old_ui 功能清单

本文按用户可见能力梳理 `old_ui/`。后续适配时，每一项都应被分类为 `compare`、`intentional_difference`、`deferred` 或 `not_applicable`。

## 产品定位

`old_ui/` 的 `package.json` 描述为 “A web-based UI for Claude Code CLI”，但当前代码已经扩展成多 provider 的本地 Web IDE。前端由 `old_ui/src/App.tsx` 装配全局 Provider，后端由 `old_ui/server/index.js` 提供 REST、WebSocket、静态资源、PTY 和若干后台服务。

核心使用路径：

```text
打开 Web UI
  -> 登录或本地免登录
  -> 选择/创建项目
  -> 选择 provider 和 session
  -> 在 Chat / Files / Shell / Git / Always-On / Memory / Skills 等页面中工作
```

## 顶层页面与导航

`old_ui/src/types/app.ts` 中的 `AppTab` 表示主要页面：

- `home`：项目入口和概览。
- `chat`：多 provider 聊天、工具调用、权限请求、slash command、图片/文件输入。
- `always-on`：Discovery、计划、cron job、后台执行历史。
- `files`：文件树、文件读取、保存、创建、重命名、删除、上传。
- `shell`：基于 xterm.js 和 `/shell` WebSocket 的交互式终端。
- `git`：status、diff、branch、commit、pull/push、publish 等 Git 操作。
- `tasks`：TaskMaster 任务管理。
- `memory`：Memory dashboard 和 memory API。
- `skills`：skills/commands 能力展示和管理。
- `preview`、`dashboard`、`plugin:*`：预览、dashboard 和插件页面。

## 项目与会话

项目模型包含：

- 项目基础信息：`name`、`displayName`、`fullPath`、`path`。
- 多 provider 会话列表：`sessions`、`cursorSessions`、`codexSessions`、`geminiSessions`。
- 分页信息：`sessionMeta.total`、`sessionMeta.hasMore`。
- 功能状态：`taskmaster`、`alwaysOn`。

会话模型包含：

- `id`、`title`、`summary`、`createdAt`、`lastActivity`、`messageCount`。
- `__provider` 和 `__projectName`，用于把多 provider 会话合并进同一 UI。
- `sessionKind: "background_task"`、`parentSessionId`、`relativeTranscriptPath`、`transcriptKey`，用于后台任务和 Always-On transcript。

适配要求：

- 新 Web UI 应继续支持“项目 -> 会话 -> 消息”的导航模型。
- 多 provider 列表可以在 PilotDeck 第一阶段收敛为 `pilotdeck` provider，但 UI 层必须保留 provider 字段或等价来源，避免破坏历史数据渲染。
- 背景任务会话不能仅当作普通聊天会话处理，必须保留父 session 和相对 transcript 路径。

## 聊天与工具渲染

聊天能力由 `chat-v2` UI 复用旧 `chat` hooks。关键能力包括：

- 流式 assistant 文本。
- thinking 文本。
- tool_use/tool_result 渲染。
- permission_request 横幅和授权操作。
- session_created 后切换到真实 session。
- abort-session 停止当前 turn。
- slash command、文件 mention、图片输入和权限模式切换。

旧 provider adapter 把 Claude、Cursor、Codex、Gemini 的 native 事件归一化成 `NormalizedMessage`。Web UI 对消息结构的依赖明显高于对 provider SDK 的依赖，因此迁移重点是保留归一化消息语义。

## 文件、Shell 与 Git

文件能力通过 `old_ui/src/utils/api.js` 暴露：

- `GET /api/projects/:projectName/files`
- `GET /api/projects/:projectName/file`
- `PUT /api/projects/:projectName/file`
- `/files/create`、`/files/rename`、`DELETE /files`、`/files/upload`

Shell 能力通过 `/shell` WebSocket 承载，后端使用 `node-pty` 启动 shell 或 provider CLI。它不是普通日志流，包含：

- 初始化 cwd/provider/session。
- stdin 输入和 resize。
- 输出流、auth URL 和 provider resume。
- 断线后 buffer 重连。

Git 能力通过 `/api/git` routes 承载，主要是项目内 Git 状态和常用操作。适配到 `src` 时应优先把 Git 能力设计成工具或 Gateway 管理接口，而不是让 Web UI 直接执行 shell 命令。

## Always-On、Cron 与 Discovery

旧 UI 中 Always-On 覆盖：

- 项目 discovery trigger。
- discovery context 和 discovery plans。
- cron job 列表、运行、删除。
- run history、run detail、run log。
- 后台 session 与 transcript 关联。

新项目 `src/cron` 与 `src/always-on` 已经具备 gateway-native 方向。迁移时应把旧 UI 的展示、操作和状态名称映射到 Gateway `cron_*` 方法和新 runtime 的存储格式。

## Settings、Auth、Plugins 与 Memory

旧 UI 还有一批横切能力：

- Auth：本地免登录、JWT token、`auth-token` localStorage、WebSocket token。
- Settings：provider 模型、权限 allow list、EdgeClaw 配置、UI 偏好。
- Plugins/Skills/MCP：插件列表、安装、启用、技能和命令接口。
- Memory：`/api/memory/*` 与 `/memory-dashboard` static/iframe 集成。

适配时不应默认全部一期实现。建议优先保留 Chat、Project、Session、Files、Git、Shell、Cron/Always-On 的主流程，插件、Memory dashboard 和 TaskMaster 可按实际产品优先级推迟。
