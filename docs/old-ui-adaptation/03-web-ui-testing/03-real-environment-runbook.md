# 真实环境验收 Runbook

本文用于适配后 Web UI 的真实本地环境验收。它补充自动化测试，但不能替代 contract 和 parity 测试。

## 前置条件

确认本机具备：

- Node 版本满足根项目和 `old_ui` 要求。
- 根项目依赖已安装。
- 至少一个可用模型 provider 配置。
- `~/.pilotdeck/pilotdeck.yaml` 或等价环境变量配置正确。
- 如果仍测试旧 UI 兼容层，`old_ui` 依赖已安装，原生依赖 `node-pty`、`better-sqlite3` 可加载。

建议先运行：

```bash
npm run build
npm test
```

如果改动 `old_ui`：

```bash
cd old_ui
npm run typecheck
npm run build
```

## 冷启动

目标：证明 Web server、静态资源、local token 和 Gateway WebSocket 能正常启动。

步骤：

1. 启动 PilotDeck Gateway/Web server。
2. 打开 Web UI。
3. 访问或间接调用 `/health`，确认 `{ ok: true }`。
4. 调用 `/auth/local-token`，确认返回 token。
5. 浏览器建立 `/ws`，发送 `hello`。
6. 确认收到 `hello_ok`，其中包含 `serverInfo`。

通过标准：

- 页面无白屏。
- WebSocket 不反复断连。
- Console 无协议 mismatch、auth failed、invalid frame。
- Network 中静态资源、token、WebSocket 请求成功。

## 基本会话

目标：证明新 Web UI 可以创建/恢复 session，并完成一个真实模型 turn。

步骤：

1. 选择一个真实项目目录。
2. 创建新 session。
3. 输入简单 prompt，例如“用一句话介绍当前项目”。
4. 观察 assistant 流式输出。
5. 等待 `turn_completed`。
6. 刷新页面。
7. 恢复同一 session，确认历史消息存在。

通过标准：

- sessionKey 稳定。
- URL、侧边栏和聊天区指向同一 session。
- 流式文本不丢失、不重复。
- 刷新后历史消息与 transcript 一致。

## 工具调用

目标：证明 Web UI 能渲染工具调用、工具结果和错误。

步骤：

1. 提示模型读取一个小文件或列出目录。
2. 观察 `tool_call_started` 渲染。
3. 等待 `tool_call_finished`。
4. 再触发一个预期失败的工具场景，例如读取不存在的文件。
5. 确认错误对用户可见。

通过标准：

- 工具名、参数摘要、结果摘要清晰。
- started 和 finished 能配对。
- 失败结果不会让 turn 永久处于 running。
- transcript replay 后工具调用仍可正确显示。

## 权限请求

目标：证明 ask 模式下 Web UI 能处理权限请求。

步骤：

1. 将权限模式切换到需要确认的模式。
2. 触发一个写文件或 shell 命令。
3. 确认页面展示 permission request。
4. 选择 deny，确认工具不执行且模型收到拒绝结果。
5. 再触发一次，选择 allow。
6. 如果支持 remember，确认 allow rule 后续生效。

通过标准：

- request id 不丢失。
- allow/deny 只能提交一次。
- deny、allow、cancel/timeout 都有明确 UI 状态。
- 权限 decision 写入 audit 或 transcript。

## 中断

目标：证明 `abort_turn` 能结束正在运行的 turn。

步骤：

1. 触发一个较长输出或长工具调用。
2. 点击停止。
3. 确认 Web UI 发送 `abort_turn`。
4. 等待最终状态。

通过标准：

- UI 不再继续追加旧 turn 内容。
- session 状态回到可输入。
- transcript 中有 interrupted 或等价记录。
- 再发送新消息不会混入旧 stream。

## Files/Git/Shell

当这些能力迁移后，逐项执行：

Files：

- 展开文件树。
- 打开文本文件。
- 保存一个小改动。
- 刷新后确认内容存在。
- 尝试访问 workspace 外路径，必须失败。

Git：

- 查看 status。
- 查看单文件 diff。
- 创建一次本地 commit 前确认 staged/unstaged 语义正确。
- push/pull 若未授权或未确认，不应自动执行。

Shell：

- 打开 terminal。
- 输入 `pwd`。
- resize。
- 断开重连。
- 关闭 session。

## Cron 与 Always-On

当 Cron/Always-On 迁移后，逐项执行：

- list cron tasks。
- create manual task。
- run now 或触发一次。
- 查看 run history。
- 打开 run log。
- 从 run 跳转到对应 session。
- stop running task。
- delete task。

通过标准：

- Cron 状态和 session 状态一致。
- 运行日志可追踪到具体 runId。
- 页面刷新后列表和历史不丢。

## 记录模板

每次真实环境验收建议记录：

```text
Date:
Commit:
OS / Node:
Command:
Model provider:
Project path:

Checks:
- cold start:
- basic turn:
- session restore:
- tool call:
- permission:
- abort:
- files/git/shell:
- cron/always-on:

Failures:
- 

Notes:
- 
```

## 失败处理

如果真实环境失败，先判断属于哪一层：

- 页面白屏：Web bundle、routing、static serving。
- WebSocket 失败：token、protocolVersion、frame shape。
- 没有回复：Gateway submit_turn、model config、AgentSession。
- 工具不显示：Gateway event 到 Web message adapter。
- 历史不恢复：session transcript reader 或 DTO。
- 权限卡住：permission request/decision 闭环。

修复后必须补自动化测试，避免 runbook 成为唯一防线。
