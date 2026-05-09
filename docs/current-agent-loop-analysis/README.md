# 当前项目 Agent Loop 功能分析

本目录只分析原项目 `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src` 中与 agent loop 紧密相关的功能、模块职责和运行机制。

## 文档结构

1. `[01-agent-loop-core.md](./01-agent-loop-core.md)`
  分析 `QueryEngine`、`query()` 和一轮 agent turn 的内核流程。
2. `[02-tool-permission-runtime.md](./02-tool-permission-runtime.md)`
  分析工具定义、工具调度、权限判断、hook、MCP 和流式工具执行。
3. `[03-context-session-runtime.md](./03-context-session-runtime.md)`
  分析输入处理、上下文构造、压缩、transcript、resume、memory、skills、plugins 和中断恢复。
4. `[04-runtime-modes.md](./04-runtime-modes.md)`
  分析交互式 REPL、print/headless、bare、SDK、remote-control、SSH、权限模式、plan mode、subagent 等不同模式。

## 总体观察

当前项目不是大比例调用外部 Claude Agent SDK 高层封装实现的应用。它依赖 `@anthropic-ai/sdk` 等底层 API 类型和客户端能力，并在项目内部实现了 agent loop、工具执行、权限系统、上下文治理、session 持久化和 SDK/headless 输出协议。