# Agent Loop 内核分析

本文只分析当前项目中 agent loop 的现有实现。

主要参考：

- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/QueryEngine.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/query.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/query/config.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/query/deps.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/services/api/claude.ts`

## 核心流程

当前项目的 agent loop 可以概括为：

```text
接收用户输入
  -> 处理 slash command、本地命令、附件和上下文
  -> 构造模型请求
  -> 流式接收 assistant 消息
  -> 捕获 tool_use
  -> 执行工具并生成 tool_result
  -> 将 tool_result 回填到消息历史
  -> 如果需要继续则进入下一轮模型请求
  -> 如果没有工具调用或达到终止条件则结束 turn
```

它不是单纯的模型调用循环，而是由会话状态、模型流、工具调度、上下文治理、错误恢复和持久化共同组成的运行时。

## QueryEngine 的职责

`QueryEngine` 是 SDK/headless 路径下的会话级封装。它负责把一次 `submitMessage()` 转换为可迭代的 SDK 消息流。

它承担的职责包括：

- 保存会话内的 `mutableMessages`。
- 保存 read file cache、permission denials、usage、abort controller。
- 为每次用户输入构造 `ProcessUserInputContext`。
- 调用 `processUserInput()` 处理 slash command、附件、本地命令和模型覆盖。
- 在进入真正 loop 前写 transcript，避免进程中断后无法 resume。
- 构造系统提示词、用户上下文、MCP 信息、工具列表、agent 定义、thinking 配置。
- 调用 `query()`，并把内部消息转换成 SDK/headless 可消费的输出事件。
- 在 query 结束后产出 result，包括 usage、cost、duration、permission denials、stop reason。

## query() 的职责

`query()` 是当前项目的核心 agent loop。它的输入包括：

- 历史消息。
- system prompt。
- user context。
- system context。
- 工具权限函数 `canUseTool`。
- tool use context。
- fallback model。
- query source。
- max turns。
- task budget。

它以 async generator 形式持续产出：

- 模型流式消息。
- request start 事件。
- assistant/user/system 消息。
- tombstone 消息。
- tool use summary。
- compact boundary。
- 终止原因。

## 单次 loop 迭代

每次 loop 迭代大致包含：

1. 从历史消息中取 compact boundary 之后的有效上下文。
2. 应用 tool result budget，裁剪过大的工具结果。
3. 应用 snip、microcompact、context collapse、autocompact 等上下文治理策略。
4. 更新 `toolUseContext.messages`。
5. 根据权限模式和上下文状态选择当前模型。
6. 检查 blocking token limit。
7. 调用模型流式接口。
8. 逐条处理 assistant 消息。
9. 捕获 assistant 内容中的 `tool_use` block。
10. 根据配置选择普通工具执行或 streaming tool execution。
11. 收集工具结果并生成 user/tool_result 消息。
12. 处理 fallback、prompt too long、max output tokens、media error、interrupt 等异常路径。
13. 如果没有工具调用，则进入 stop hook 或结束。
14. 如果有工具调用，则把 assistant 消息和 tool result 追加进消息历史并继续下一次模型请求。

## 继续条件

当前项目判断是否继续，主要不依赖 `stop_reason === 'tool_use'`。代码注释中明确说明该字段不总是可靠。真正的继续信号是流式 assistant 消息中是否出现 `tool_use` block。

继续条件包括：

- 本轮 assistant 消息包含一个或多个 tool use。
- 工具执行产生了需要回填给模型的结果。
- fallback model、reactive compact、max output tokens recovery 等恢复路径要求重新请求。
- stop hook 触发后要求继续。

## 终止条件

终止条件包括：

- assistant 消息没有 tool use。
- 达到 max turns。
- 用户中断。
- blocking context limit。
- 模型错误或不可恢复错误。
- 权限或工具结果导致 loop 无法继续。

## 模型调用边界

当前 `query()` 通过 `deps.callModel()` 调用模型。模型调用需要接收：

- messages。
- system prompt。
- thinking config。
- tools。
- abort signal。
- model / fallback model。
- task budget。
- query source。
- MCP tools。
- agent definitions。
- fast mode / effort / advisor 等运行时选项。

这说明当前项目虽然直接使用底层模型 SDK，但在 `query/deps.ts` 这一层已经有一定依赖注入边界。

## 事件流特征

当前项目同时支持 SDK/headless、REPL 和其他客户端形态，核心原因是内部 loop 以 generator 形式持续产出消息和事件。

事件流中会出现：

- request start。
- assistant message。
- user/tool_result message。
- system message。
- tombstone。
- compact boundary。
- tool use summary。
- result。

这些事件共同构成外部入口可消费的 agent turn 输出。

## 当前内核的复杂点

当前实现的复杂度主要来自：

- `query.ts` 同时承载上下文治理、模型请求、工具调度、错误恢复、telemetry、feature flag。
- 继续和恢复路径分布在多个嵌套结构中。
- 流式工具执行和普通工具执行并存。
- compact、tool result budget、context collapse 等上下文策略与模型请求强耦合。
- feature flag 与运行时逻辑交织。

