# old_ui 现状分析

本目录记录 `old_ui/` 的现有功能、架构与运行逻辑。它的目的不是把旧代码原样迁入新项目，而是为后续适配提供可验证的行为清单。

## 文档列表

- `01-feature-inventory.md`：功能清单、用户流程和页面能力。
- `02-architecture-and-runtime.md`：前端、后端、WebSocket、PTY、provider adapter 与构建运行方式。
- `03-data-protocols-and-state.md`：项目、会话、消息、REST、WebSocket、localStorage 与配置状态。

## 当前结论

`old_ui/` 是一个 React/Vite 前端加 Express/WebSocket 后端的本地 Web IDE。它把项目管理、会话聊天、文件编辑、Shell、Git、Always-On、Memory、Skills、Plugins、MCP 和多 provider 会话都放在同一套 Web 服务里。

迁移时应特别关注这些行为边界：

- `/api/projects` 与 `/api/sessions/:sessionId/messages` 形成项目和历史消息事实接口。
- `/ws` 承载聊天流、session 创建、权限请求、状态更新和中断。
- `/shell` 承载 PTY 终端，与 provider CLI resume 逻辑耦合较深。
- `Project`、`ProjectSession`、`NormalizedMessage` 是 UI 渲染和状态归并的核心模型。
- 认证、环境变量、EdgeClaw 配置、外部 CLI 和 SQLite/本地文件系统依赖混在 `server/index.js` 与 routes/services 中。
