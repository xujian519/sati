# src 改写与补齐方案

本文从 `src/` 角度描述为了适配 Web UI 需要新增或调整的能力。原则是补稳定协议，不让 UI 依赖内部实现。

## 已有基础

当前 `src/` 已经具备：

- `src/agent`：AgentSession、TurnRunner、AgentLoop。
- `src/gateway`：in-process / WebSocket Gateway 与协议类型。
- `src/session`：transcript、metadata、list、resume。
- `src/model`：canonical model protocol、provider adapter、streaming。
- `src/tool`：registry、runtime、builtin tools、scheduler。
- `src/pilot/config`：PilotDeck config 加载与诊断。
- `src/cron`：cron runtime 和 Gateway 管理方法。
- `src/always-on`：gateway-native discovery runtime 方向。

Web UI 最应该复用的是这些模块的公开协议，而不是复用 TUI 组件或 CLI 参数解析。

## 必须补齐的 Gateway 方法

当前 Gateway 方法已覆盖 turn、session 和 cron 的一部分。为了支撑旧 UI 主流程，建议增加：

```text
read_session_messages
rename_session
delete_session
list_projects
describe_project
read_project_file_tree
read_project_file
write_project_file
git_status
git_diff
git_commit
git_branch_list
git_pull
git_push
always_on_status
always_on_run_history
always_on_run_log
```

如果不想扩大 Gateway 方法集合，也可以暴露 HTTP Web adapter。但不论走哪条路，都要遵守：

- DTO 稳定。
- 输入输出有 schema 或类型。
- 错误有 code。
- workspace root 限制在服务端校验。
- 测试覆盖 contract。

## Session 与 Transcript API

旧 UI 依赖历史消息分页。`src/session` 应对 Web UI 暴露稳定 reader：

```text
readSessionMessages(input)
  sessionKey
  projectKey?
  cursor?
  limit?
  direction?
```

输出：

```text
{
  messages: WebMessage[],
  nextCursor?: string,
  total?: number,
  session: WebSessionSummary
}
```

`WebMessage` 不应直接等于 internal transcript record。它应是 Web 渲染 DTO：

- assistant text delta 在历史中应合并为可读 assistant message，或明确标记为 replay delta。
- tool call/result 必须保留 id 配对。
- permission request 必须保留 request id、toolName、payload。
- error/interrupt/complete 必须可见。

## Permission Interaction

`src/gateway/protocol/types.ts` 已声明 `permission_request` 事件，但 Web UI 需要完整闭环：

- Gateway 能发出 permission request。
- Web UI 能提交 allow/deny/remember。
- Agent/tool runtime 能等待该 decision。
- decision 进入 audit 或 transcript。
- timeout/cancel 有明确事件。

建议新增：

```text
permission_decide
```

或将 permission decision 作为 `submit_turn` stream 关联请求处理。无论哪种方案，request id 必须稳定，且一个 request 只能决策一次。

## Project/File API

为了迁移 Files 页面，`src` 需要提供 workspace-safe project file service：

- list tree：支持 ignore、limit、binary 标记、目录展开。
- read file：支持文本、二进制元数据、大小限制。
- write file：必须校验 workspace root 和权限模式。
- create/rename/delete/upload：必须有可测试错误码。

安全要求：

- 禁止 `..` 跳出 workspace root。
- symlink 策略必须明确。
- 写操作应经过 permission policy 或 Web 独立 ACL。
- 大文件、二进制文件、权限错误要返回结构化错误。

## Git API

Git 页面需要结构化响应：

- status：文件状态列表和 branch。
- diff：按文件读取 diff。
- commit：message、author、changed files。
- branch：list/create/switch。
- remote：pull/push/publish。

建议先实现只读 status/diff，再做 commit/push。push 属于外部副作用，应默认 require confirmation 或受 permission config 控制。

## Terminal API

Shell 页面有两种选择：

1. 短期保留旧 `/shell` WebSocket，标记为 legacy compatibility。
2. 新增 Gateway terminal extension：

```text
terminal_open
terminal_input
terminal_resize
terminal_close
terminal_event
```

新 terminal 不应绑定某个 provider CLI。它应该是 workspace terminal，provider 相关操作通过 PilotDeck Chat/Gateway 完成。

## Web Static 与启动

`GatewayServer` 已支持 `staticAssetsPath`，可承载 Web bundle。建议：

- `pilotdeck server --web` 启动 Gateway 和静态 UI。
- `GET /auth/local-token` 仅限 localhost。
- 非 localhost 绑定需要重新设计 auth，不复用本地 token。
- Web UI 构建产物与根 `npm run build` 的关系要明确，避免根 build 隐式失败或跳过。

## 测试要求

每新增一个 Web-facing 方法，都要同时新增：

- 协议类型测试。
- 错误码测试。
- workspace boundary 测试。
- fake gateway/client contract 测试。
- 如果对应旧 UI 行为为 `compare`，还要有 legacy parity scenario。

不能仅靠手动浏览器点击作为验收。
