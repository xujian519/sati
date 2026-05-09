# TUI 真实环境测试文档

本目录用于管理 PolitDeck TUI 在真实运行环境中的验收文档。这里的“真实环境”指通过 `src/cli/politdeck.ts`、`src/adapters/channel/tui/`、`src/gateway/`、`src/agent/`、`src/model/` 和 `src/tool/` 组成的真实链路运行，而不是只验证 reducer 或纯渲染函数。

## 范围

当前 TUI 实现位于：

```text
src/adapters/channel/tui/
  TuiChannel.ts
  tui-render.ts
  app/
    TuiApp.tsx
    Header.tsx
    WelcomeCard.tsx
    PromptInput.tsx
    MessageList.tsx
    MessageResponse.tsx
    ActivityLine.tsx
    HelpDialog.tsx
    types.ts
```

真实验收覆盖：

- 交互式启动：`politdeck tui`。
- 本地 in-process Gateway：TUI 直接创建 `createLocalGateway()`。
- 远端 Gateway：先启动 `politdeck server`，TUI 自动探测并连接。
- 真实模型 turn：从 TUI 输入消息，经 Gateway、AgentSession、Router、ModelRuntime 流式返回。
- 真实工具 turn：使用 `scripts/tui-e2e-record.tsx` 注册 `add_numbers` 工具，并记录 TUI 帧日志。
- TUI 命令：`/help`、`/new`、`/sessions`、`/mode`、`/clear`、`/exit`。

## 文档索引

1. `[01-environment-and-runbook.md](./01-environment-and-runbook.md)`：真实环境准备、配置要求和通用记录方式。
2. `[02-cold-start-and-local-commands.md](./02-cold-start-and-local-commands.md)`：冷启动、帮助弹窗、会话和模式命令测试。
3. `[03-real-model-basic-turn.md](./03-real-model-basic-turn.md)`：通过 TUI 发起真实模型对话。
4. `[04-real-tool-use-e2e-record.md](./04-real-tool-use-e2e-record.md)`：通过 TUI 帧记录脚本验证真实工具调用。
5. `[05-remote-server-session.md](./05-remote-server-session.md)`：启动真实 server 后验证 TUI 远端连接和会话列表。

## 通过标准

所有用例都必须写明：

- 输入：终端命令、TUI 输入文本、必要环境变量。
- 预期现象：屏幕上应出现或不应出现的 TUI 状态。
- 预期输出：命令退出码、帧日志、模型答案、错误文案或会话记录。

真实模型和真实工具用例会访问外部 provider，默认不应纳入普通 `npm test`；它们适合本地验收、nightly 或发布前 smoke test。
