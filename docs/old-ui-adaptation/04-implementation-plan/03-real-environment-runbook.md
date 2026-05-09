# Web UI 真实环境验证 Runbook

本 runbook 描述 Web UI 在真实 PilotDeck 环境下的验收步骤。CI 中只跑 contract / parity 测试；本 runbook 在迁移阶段每周或在重大改动后人工执行一次。

执行命令默认在仓库根目录。

## 0 准备

```bash
npm install
npm run build
(cd ui && npm install && npx vite build)
```

确认 `~/.pilotdeck/pilotdeck.yaml` 至少包含：

- `agent.model.provider`、`agent.model.model`
- 你信任的 provider API key（环境变量或 keychain，见 `docs/pilot-config/`）

## 1 冷启动

```bash
node dist/src/cli/pilotdeck.js server --port 18789
```

预期：
- `PilotDeck server listening: http://127.0.0.1:18789`
- `WebSocket: ws://127.0.0.1:18789/ws`
- `Token:` 路径或 token 输出。

打开浏览器访问 `http://127.0.0.1:18789`，期望 React UI 加载，顶部状态变为 `connected`。

## 2 项目与 Session

- 左侧 Projects 列表至少包含当前 cwd。
- 点击项目 → Sessions 列表刷新。
- 点击 `+ New` → 新 session 创建并选中。

验证 `dist/tests/.../list-projects.test.js` 已通过的同时这里也可见。

## 3 Chat 流式

- 在 composer 输入文字 → 看到 user message 立即出现。
- 模型流式回复合并为单条 assistant message（不应每个 delta 一行）。
- `Stop` 按钮在 running 时可见，点击后 stream 终止并出现 error 行。
- 完成后底部出现 `turn complete · completed` 状态行。

## 4 历史恢复

- 刷新页面。
- 期望先看到 `Loading history…`，随后 user + assistant 历史消息按时间顺序加载。
- `applyWebGatewayEvent` 只追加 `source: "live"` 的新行，不重渲染历史。

## 5 工具调用（如果 agent 调用工具）

- 看到 `tool · <name> · running`。
- 完成后变为 `tool · <name> · ok` 或 `error`，并显示 result preview。
- 若工具 `isError: true` → 行边框变红。

## 6 权限闭环

如果你启用了需要确认的工具（如配置 `bash` 在 `default` 模式）：

- 看到黄色 permission banner。
- 点 `Allow once` / `Allow + remember` / `Deny`。
- 期望 banner 消失；后台 `permission_decide` 返回 `delivered: true`。
- 工具继续运行（allow）或被拒（deny）。

> 若 banner 永不消失：`createLocalGateway` 是否未把 permission_decide 接到 agent runtime 的 hook？检查 `src/permission/` 与 `tool/execution/ToolRuntime.ts` 的 `dispatchLifecycle("PermissionRequest", ...)` 调用，必要时在 hook 内通过 `gateway.getPermissionBus().register(...)` 注册并 emit `permission_request`。

## 7 Files

- 切换到 Files tab。
- 看到当前目录文件列表，点目录可下钻；点文本文件可在右侧预览。
- 二进制文件应只展示 metadata。
- URL 路径中带 `..` 应被服务器以 403 拒绝（开浏览器 devtools 验证）。

## 8 Git

- 切到 Git tab。
- 看到当前分支，已修改/未追踪文件可见。
- 点击文件 → 右侧出现 diff。
- 屏幕底部明示 commit / pull / push 当前为 deferred。

## 9 Cron

- 切到 Cron tab。
- 创建 `*/1 * * * *` 任务。
- 看到任务出现于列表，`Next run` 字段填充。
- Delete 后从列表消失。

## 10 Deferred 占位

切换到 Shell / Memory / Skills / Plugins / Always-On / Settings：

- 每个 tab 显示“暂未迁移”面板与原因。
- 不出现破坏性请求。

## 失败诊断分层

| 现象 | 第一层定位 |
| --- | --- |
| WS 连不上 | `health` 是否 200？token 是否过期？ |
| chat 无回包 | server 终端是否有 model error？检查 router/model config。 |
| permission 卡死 | gateway permission bus 未连入 agent hooks（见 §6）。 |
| Files 403 | 检查 `resolveProject` 是否把 projectKey 映射到工作区。 |
| Git error | 该 cwd 是否 git 仓库？`git --version` 是否可用？ |

## 验收记录格式

每次执行 runbook，归档到 `artifacts/web-ui-runbook-YYYYMMDD.md`，至少写：

- PilotDeck commit。
- node + npm 版本。
- 哪些 step 通过、哪些跳过、哪些失败 + 失败截图链接。
- 是否需要更新 `tests/fixtures/web-ui/parity-scenarios.ts` 的状态。
