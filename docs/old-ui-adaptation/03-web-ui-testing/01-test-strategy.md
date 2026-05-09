# Web UI 测试策略

本文定义适配后 Web UI 的测试分层。原则：协议优先、行为可复现、真实环境单独 gated。

## 测试分层

```text
Type/unit tests
  -> Gateway client contract tests
  -> Web adapter service tests
  -> UI component/hook tests
  -> Browser E2E tests
  -> Real environment runbook
  -> Legacy parity scenarios
```

每一层只验证自己负责的边界，避免一个 Playwright case 同时承担协议、状态、渲染和真实模型质量。

## 根项目测试

根项目使用 TypeScript build 和 Node 内置 test runner：

```bash
npm run build
npm test
```

适配 Web UI 时，应在根测试中新增：

- `tests/gateway/`：Web Gateway 方法和帧协议。
- `tests/session/`：Web message DTO 和 transcript replay。
- `tests/permission/`：permission_request 和 decision 闭环。
- `tests/cron/` 或 `tests/always-on/`：Web UI 需要的 Cron/Always-On 管理面。
- `tests/adapters/web/`：Web adapter 的 HTTP/Gateway 边界。

## old_ui 兼容测试

如果改写仍发生在 `old_ui/` 内，至少运行：

```bash
cd old_ui
npm run typecheck
npm run lint
npm run build
```

旧项目没有统一 `npm test` 脚本，但已有若干 `*.test.{js,ts,tsx}` 和 Vitest/Playwright 依赖。若要启用这些测试，应先新增明确脚本，例如：

```bash
npm run test:unit
npm run test:e2e
```

不要在文档或 PR 中写“old_ui 测试通过”，除非脚本存在且实际运行。

## Gateway Client Tests

Web Gateway client 必须覆盖：

- open 后发送 `hello`。
- token 错误时连接关闭或失败。
- protocolVersion mismatch。
- `request` id 与 `response` id 匹配。
- `submit_turn` event stream 按 `seq` 顺序处理。
- `final: true` 时清理 stream。
- final 合成 `turn_completed` 不重复渲染成消息。
- 并发 submit_turn 不串流。

这些测试可以使用 fake WebSocket 或本地 Gateway server，不需要真实模型。

## UI Hook 和组件测试

优先测试逻辑 hook：

- session list 加载和分页。
- submit message 状态机。
- stream delta 累积。
- tool call started/finished 配对。
- permission request banner 和 decision。
- abort 后状态收敛。
- transcript replay 后消息去重。

组件测试只覆盖关键渲染：

- assistant/user/tool/error/permission/interrupted 消息。
- empty/loading/error states。
- tabs 和 session 切换不丢状态。

## Browser E2E

浏览器 E2E 使用 fake Gateway 优先，不直接依赖真实模型：

- 打开 UI，读取 local token，建立 Gateway。
- 创建新 session。
- 发送 prompt，fake Gateway 返回 text delta。
- fake Gateway 返回 tool call started/finished。
- fake Gateway 返回 permission_request，页面点击 allow。
- abort turn。
- 刷新页面并恢复历史消息。

真实模型 E2E 应单独 gated，见 `03-real-environment-runbook.md`。

## 测试数据

建议建立共享 fixtures：

```text
tests/fixtures/web-ui/
  projects/
  sessions/
  messages/
  gateway-events/
  parity-scenarios/
```

fixture 必须包含：

- 普通聊天。
- 带 thinking 的聊天。
- 带工具调用的聊天。
- 工具失败。
- 权限请求 allow/deny。
- 中断。
- 背景任务 session。
- 历史消息分页。

## 验收规则

一次适配 PR 至少满足：

- 根 `npm run build` 通过。
- 根 `npm test` 通过。
- 如果改动 `old_ui/src`，运行 `old_ui` typecheck/build。
- 新增或更新对应 contract 测试。
- 如果声称旧行为一致，必须有 parity scenario 结果。
- 如果跳过真实模型测试，PR 描述或记录中必须写明未运行原因。
