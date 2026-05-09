# old_ui 到 PolitDeck 的适配矩阵

本文把旧 UI 能力映射到新项目目标边界。状态含义：

- `compare`：可以用共享场景同时跑旧实现和新实现，输出必须匹配。
- `intentional_difference`：新行为有意不同，需要记录原因和风险。
- `deferred`：旧行为存在，但本阶段不实现。
- `not_applicable`：旧行为不迁移。

## 核心矩阵

| 旧 UI 能力 | 旧实现位置 | 新项目目标边界 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| 项目列表 | `/api/projects` | Web project API 或 Gateway `list_projects` | `compare` | 字段可调整，但 project identity、path、session summary 必须可比。 |
| 会话列表 | `/api/projects/:name/sessions` | Gateway `list_sessions` | `compare` | 需要保留分页/cursor、lastActivity、summary。 |
| 历史消息 | `/api/sessions/:id/messages` | `src/session` reader + Web DTO | `compare` | tool/result、thinking、error、permission 必须保留语义。 |
| 发送聊天 | `/ws` `*-command` | Gateway `submit_turn` | `compare` | 流式输出、tool call、complete/error 必须通过 shared scenarios 验证。 |
| 中断 turn | `/ws` `abort-session` | Gateway `abort_turn` | `compare` | 需要验证中断事件和最终状态。 |
| 权限请求 | provider runtime + WebSocket | Gateway `permission_request` + decision method | `compare` | 当前 `src` 需补完整 decision 闭环。 |
| 权限模式 | localStorage + provider args | Gateway `mode` + `PermissionConfig` | `compare` | 至少覆盖 `default`、`plan`、`bypassPermissions`，`acceptEdits` 按新项目语义定义。 |
| 文件树 | `/api/projects/:name/files` | Web file service | `compare` | 工作区边界、ignore、二进制标记需测试。 |
| 文件读写 | `/file`、`/files/content` | Web file service + permission | `compare` | 写操作必须经过权限或 Web ACL。 |
| Git status/diff | `/api/git/*` | Git service 或 Gateway 方法 | `compare` | 结构化结果优先，避免解析 shell 输出。 |
| Git commit/push | `/api/git/*` | Git service + permission | `compare` | push 是外部副作用，默认需要确认。 |
| Shell | `/shell` + `node-pty` | Terminal extension 或 legacy adapter | `deferred` | 可短期保留旧协议，中期重设为 workspace terminal。 |
| Cron list/create/delete/stop | project cron routes | Gateway `cron_*` | `compare` | 当前 Gateway 已有基础方法。 |
| Cron run now/history/log | project always-on routes | `src/cron`/`src/always-on` Web API | `deferred` | 需要 `src` 补接口。 |
| Always-On discovery | discovery routes/services | `src/always-on` | `deferred` | 保留产品目标，分阶段迁。 |
| Memory dashboard | `/api/memory` + `/memory-dashboard` | PolitDeck memory/context API | `deferred` | 不作为第一阶段阻断项。 |
| Skills | `/api/skills` | `src/extension` skills contributions | `deferred` | 先保证只读展示，再做管理。 |
| Plugins | `/api/plugins` + plugin proxy | `src/extension` plugins | `deferred` | 插件安装/运行涉及较大安全面。 |
| MCP 管理 | `/api/mcp` | `src/mcp` + extension contributions | `deferred` | 需要与 config 和 permission 一起设计。 |
| TaskMaster | `/api/taskmaster` | 未定 | `not_applicable` | 除非产品重新确认保留。 |
| 旧 provider 多会话 | Claude/Cursor/Codex/Gemini adapters | PolitDeck session/provider-neutral runtime | `intentional_difference` | 新项目不以旧 provider 存储为主事实来源。 |
| 本地免登录 | `CLOUDCLI_DISABLE_LOCAL_AUTH` | localhost token | `intentional_difference` | 新 Gateway 使用 `/auth/local-token`，非 localhost 需要新 auth。 |

## 第一阶段必须 compare 的能力

第一阶段要做到可用 Web Chat，至少覆盖：

- 项目选择和当前项目展示。
- 新建 session、恢复 session、列出 session。
- 发送单 turn 并流式渲染 assistant text。
- tool call started/finished 渲染。
- permission_request 展示和 decision。
- abort_turn。
- 刷新页面后从 transcript 恢复历史消息。

## 允许 intentional difference 的能力

这些差异可以接受，但必须写入变更说明：

- provider 选择从 `claude/cursor/codex/gemini` 收敛为 PolitDeck config/router。
- 认证从旧 JWT/local auth 改为 localhost Gateway token。
- session id 从 provider 原生 id 改为 `sessionKey`。
- 历史消息可以从 delta replay 合并为更适合阅读的 Web message，但 tool/result pairing 不能丢。

## deferred 的退出条件

被标记为 `deferred` 的能力不能无限期停留。每项都需要：

- 明确用户是否会在 UI 中看到入口。
- 如果入口隐藏，要有 feature flag 或导航移除说明。
- 如果入口保留，要显示“暂未迁移”或等价状态。
- 后续实现时补对应 contract/parity 测试。
