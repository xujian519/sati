# old_ui 架构与运行逻辑

本文记录 `old_ui/` 的架构切分和运行链路，为后续拆分或重写提供依据。

## 技术栈

前端：

- React 18、React Router、Vite、TypeScript/JavaScript 混写。
- Tailwind CSS、Radix UI、lucide-react。
- CodeMirror、xterm.js、react-markdown、i18next。
- `allowJs` 式工程形态，类型约束并不完整。

后端：

- Node ESM、Express、`ws`、`node-pty`。
- `better-sqlite3`、`sqlite3`、本地 JSONL、CLI 配置目录和文件系统。
- provider SDK/CLI：Claude Agent SDK、Cursor CLI、Codex SDK、Gemini CLI。

构建运行：

- `npm run dev`：并发启动 server 和 Vite client。
- `npm run server`：`node server/index.js`。
- `npm run client`：`vite`。
- `npm run build`：`vite build`。
- `npm run typecheck`：`tsc --noEmit -p tsconfig.json`。
- `npm run lint`：`eslint src/`。

## 前端装配

`old_ui/src/App.tsx` 是前端根组件，依次装配：

- `I18nextProvider`
- `ThemeProvider`
- `AuthProvider`
- `WebSocketProvider`
- `PluginsProvider`
- `TasksSettingsProvider`
- `TaskMasterProvider`
- `ProtectedRoute`
- `BrowserRouter`
- `AppShellV2`

路由上只注册一个 wildcard route，避免 URL 切换时重挂载 shell。实际 URL 语义在 `AppShellV2` 内部解析，包括：

- `/`
- `/p/:projectName`
- `/p/:projectName/c/:sessionId`
- `/session/:sessionId`

这种设计的优点是全局状态稳定，缺点是很多页面状态和路由状态耦合在 shell 内部。迁移到新 UI 时可以保留“shell 不随 session 切换重挂载”的原则，但应把 URL 解析、project/session selection 和 tab state 明确拆成小模块。

## 后端装配

`old_ui/server/index.js` 是高度集中的服务入口，负责：

- Express app、中间件、静态资源和 CORS。
- `/api/*` 鉴权和 routes mount。
- `WebSocketServer`，同时处理 `/ws` 和 `/shell`。
- provider command 分发。
- Shell PTY 会话管理。
- plugin WebSocket proxy。
- memory dashboard static serving。
- startup、discovery、cron、config broadcast 等副作用。

主要 REST routes 包括：

- `/api/auth`
- `/api/projects`
- `/api/git`
- `/api/mcp`
- `/api/cursor`
- `/api/taskmaster`
- `/api/memory`
- `/api/commands`
- `/api/skills`
- `/api/settings`
- `/api/config`
- `/api/codex`
- `/api/gemini`
- `/api/plugins`
- `/api/sessions`
- `/api/ccr`
- `/api/agent`

适配时不建议把这个入口原样迁入 `src`。更稳妥的做法是把它拆成：

- Web adapter：负责 HTTP/static/WebSocket 入口。
- Gateway client/server：负责 turn、session、cron 等协议。
- Project/file/git service：按明确接口实现。
- Legacy compatibility layer：只在迁移期提供旧 REST 形状。

## WebSocket 运行逻辑

旧 UI 有两条 WebSocket 路径。

`/ws` 用于聊天和运行时事件：

- 前端通过 `WebSocketContext` 建立连接。
- 本地免登录时直接连接 `/ws`；否则附带 `?token=`。
- 收到消息后同步 fan-out 给 subscribers，再更新 React state。
- 高频流式消息必须走 `subscribe()`，不能只依赖 `latestMessage`，否则 React batching 可能丢中间 delta。

`/ws` 接收的旧命令包括：

- `claude-command`
- `cursor-command`
- `codex-command`
- `gemini-command`
- `abort-session`
- permission decision 相关消息

`/shell` 用于交互终端：

- 初始化 cwd、provider、session 等。
- 发送 input/resize。
- 返回 output/auth_url/status。
- 后端维护 PTY 和断线重连。

迁移到 PilotDeck 时，聊天 `/ws` 应映射到 `src/gateway/protocol/frames.ts` 中的 hello/request/event/response 帧；Shell `/shell` 可以暂时作为独立能力保留，直到 `src` 有明确 terminal adapter。

## Provider Adapter

旧 UI 的 `server/providers` 负责把不同 provider 的历史与实时事件归一化：

- Claude：读取 `~/.claude/projects/{projectName}/*.jsonl`。
- Cursor：读取本地 SQLite store。
- Codex：读取 `~/.codex/sessions/*.jsonl`。
- Gemini：读取 session manager 或 `~/.gemini/tmp/`。

统一接口包括：

- `fetchHistory(sessionId, opts)`
- `normalizeMessage(raw, sessionId)`

PilotDeck 新项目已经有 canonical model protocol 和 Gateway event，因此不应继续让 Web UI 绑定这些旧 provider adapter。迁移期可以增加一个 `pilotdeck` adapter，把 Gateway event 转成旧 `NormalizedMessage`，让现有聊天组件先运行起来。

## 原生依赖和环境风险

旧 UI 的运行依赖明显偏本机：

- `node-pty` 和 `better-sqlite3` 是原生依赖，安装和平台兼容风险较高。
- 外部 CLI 依赖 `claude`、`cursor-agent`、`codex`、`gemini`、`bun`。
- 配置和数据依赖 `~/.cloudcli`、`~/.edgeclaw`、`~/.claude`、`~/.cursor`、`~/.codex`、`~/.gemini`。
- `CLOUDCLI_DISABLE_LOCAL_AUTH` 默认影响认证路径。

新项目应把这些依赖关进 adapter 层：核心 `src/agent`、`src/model`、`src/tool`、`src/session` 不直接知道浏览器、Express、PTY、SQLite 或某个旧 provider 的目录布局。
