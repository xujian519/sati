# Web UI Parity 测试维护指南

本文与 `01-web-ui-replication-development-guide.md` 配套。规则：没有共享场景同时跑旧/新两端，不得声称 parity passed。

## 测试分层

```
unit
  -> Gateway browser client contract
  -> WebMessage reducer / web-message-mapper
  -> Web HTTP adapter contract
  -> UI hook (state) tests
  -> UI component snapshot/rendering
  -> Browser E2E (fake gateway)
  -> Real environment runbook (gated)
  -> Dual parity scenarios
```

## 文件目录约定

```
tests/
  fixtures/web-ui/
    parity-scenarios.ts     共享 scenario 描述（id + status + reason 等）
    web-messages.ts         典型 WebMessage 样本
    gateway-events.ts       典型 GatewayEvent 样本
  helpers/web-ui/
    fakeGateway.ts          浏览器 client 测试用的 fake WS server
    normalizeWebReport.ts   归一化函数（不允许吃掉语义字段）
  web-ui-client/            ui/src/gateway 在 Node 下的契约/单元测试
  web-message-mapper/       WebMessage reducer 测试
  adapters/web/             Web HTTP adapter 测试
  permission/               permission_decide 测试
  session/                  read_session_messages 测试
```

## Scenario 状态语义

每个 scenario 必须显式标注：
- `compare`：旧/新都跑，归一化输出深比较一致。
- `intentional_difference`：写明 reason + risk + 用户影响。
- `deferred`：写明补齐条件。
- `not_applicable`：写明不迁移原因。

`tests/fixtures/web-ui/parity-scenarios.ts` 通过类型 + 单测强制每个 scenario 有 `status` 与 `reason`。

## 第一批必备 Scenarios

| id | status | 备注 |
| --- | --- | --- |
| project-list-basic | compare | `list_projects` 与 old `/api/projects` 字段映射 |
| session-list-basic | compare | `list_sessions` cursor/limit |
| session-history-text-only | compare | text-only turn replay |
| session-history-tool-call | compare | tool started/finished pairing |
| submit-turn-text-stream | compare | live delta 累积 |
| submit-turn-tool-call | compare | tool 流式 |
| submit-turn-error | compare | recoverable / non-recoverable error 映射 |
| abort-turn | compare | abort 后 final 状态 |
| permission-request-allow | compare | decision 闭环 |
| permission-request-deny | compare | 决定后 transcript 落 audit |
| history-pagination | compare | offset/cursor parity |
| background-task-session | compare | sessionKind=background_task 隔离 |

后续 Phase 追加：
- file-tree-basic / file-read-text / file-write-text / file-binary-metadata
- git-status-basic / git-diff-basic
- terminal-open-input-resize（terminal extension 实装时启用）
- cron-list-create-delete / always-on-run-history

## 归一化规则

### 允许归一化
- 绝对临时路径 → workspace 相对路径
- timestamp / duration / PID
- UUID 随机部分
- WebSocket `seq` 起始值（保留相对顺序）

### 禁止归一化
- success vs error
- error code
- permission allow vs deny
- tool name
- tool input 语义字段
- tool result `ok`
- 用户可见 assistant 关键文本
- 文件写入后内容
- session 是否可恢复

## 关键 contract 测试

### Gateway browser client

`tests/web-ui-client/`：
- open 后发 `hello`，protocolVersion mismatch / token 错误 → 关闭。
- request id 与 response id 配对，未知 method 报错。
- `submit_turn` 按 `seq` 顺序发出 events，`final: true` 清理 stream，`turn_completed` 不重复渲染。
- 并发 submit_turn 不串流（不同 id 的 stream 独立）。
- 断线时所有 pending request reject、所有 stream 失败。

### WebMessage reducer

`tests/web-message-mapper/`：
- `assistant_text_delta` 累积到同一 assistant message。
- `tool_call_started` + `tool_call_finished` 配对。
- `permission_request` 不被 reduce 进 assistant 流。
- `error` / `turn_completed` / `elicitation_cancelled` 保留为独立消息。
- live 与 history 来源都返回稳定形状（`source` 字段不同）。

### Web HTTP adapter

`tests/adapters/web/`：
- 401 无 token / 错 token。
- 403 越界路径或 workspace root 校验失败。
- 404 项目不存在。
- 200 正常返回 + JSON schema 校验。
- 写入测试 → 读取后内容一致。

### Permission decide

`tests/permission/`：
- gateway 发出 permission_request。
- Web `permission_decide` allow → 工具继续执行。
- deny → 工具被拒，turn 收到 `tool_call_finished(ok=false)` 或对应错误。
- duplicate decide → 第二次返回 `{ delivered: false }`。
- turn abort 后 decide → `{ delivered: false }` 不影响后续。

## 运行命令

```
npm run build
npm test
```

`npm test` 跑根 `tests/`。`ui/` 暂不引入独立 test runner（Vite + tsc 已满足 Phase 1）；浏览器侧逻辑通过 `tests/web-ui-client/` 在 Node 下用 `globalThis.WebSocket = mockWebSocket` 跑。

E2E（Playwright 等）单独 gated 在 CI matrix，第一阶段不阻断 PR。

## PR 验收清单

- 根 `npm run build` 通过。
- 根 `npm test` 通过。
- 受影响 contract scenario 全部 compare 一致。
- 新增 deferred 必须在 `parity-scenarios.ts` 写明补齐条件。
- 新增 intentional_difference 必须写 risk + 用户影响。
- 涉及 `src/gateway/protocol/`、`ui/src/gateway/` 类型变更时，必须有协议同步测试。
