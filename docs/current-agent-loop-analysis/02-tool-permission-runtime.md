# 工具与权限运行时分析

本文只分析当前项目中工具、权限、hook、MCP 和工具调度与 agent loop 的关系。

主要参考：

- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/Tool.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/tools.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/services/tools/toolOrchestration.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/services/tools/StreamingToolExecutor.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/services/tools/toolExecution.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/hooks/useCanUseTool.tsx`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/permissions/permissions.ts`

## 工具系统在 loop 中的位置

agent loop 本身不直接完成文件、shell、搜索、MCP 等动作。它接收模型输出的 `tool_use`，再把工具执行结果回填成 `tool_result`。

工具系统与 loop 的关系包括：

- 工具 schema 会进入模型请求。
- 工具调用由 assistant 流式消息触发。
- 工具结果决定下一次模型请求的上下文。
- 工具权限可能阻塞、拒绝或修改输入。
- 工具执行进度需要实时反馈给 UI/SDK。
- 工具失败必须转成协议兼容的 tool_result。

## Tool 上下文

`Tool.ts` 中的 `ToolUseContext` 包含大量运行时信息：

- 当前工具列表和命令列表。
- 当前模型和 thinking 配置。
- MCP client 和 MCP resources。
- app state。
- abort controller。
- read file cache。
- 权限上下文。
- UI 回调。
- 通知回调。
- session / agent / query tracking。
- file history 和 attribution。
- progress 事件。
- compact 进度。

这表明当前工具不是简单函数调用，而是运行在完整会话上下文中的执行单元。

## 工具注册表

`src/tools.ts` 是集中式工具注册表，混合了：

- 基础工具：Agent、Bash、FileRead、FileEdit、FileWrite、Glob、Grep、WebFetch、Todo 等。
- 环境相关工具：PowerShell、LSP、Worktree。
- feature-gated 工具：Sleep、Cron、RemoteTrigger、Workflow、WebBrowser 等。
- ant-only 或内部工具。
- 测试工具。
- deprecated alias 兼容。

这使 `tools.ts` 同时承担工具清单、构建分支、运行时开关和兼容处理职责。

## 工具执行路径

当前工具执行大致分为：

```text
tool_use
  -> findToolByName
  -> alias fallback
  -> input schema validation
  -> tool-specific validateInput
  -> permission decision
  -> pre tool hooks
  -> execute tool
  -> progress messages
  -> post tool hooks
  -> normalize result
  -> create user/tool_result message
```

执行路径中的关键行为：

- 找不到工具时返回匹配 `tool_use_id` 的错误 tool_result。
- schema 错误时返回可指导模型修正的错误。
- 工具自身校验失败时不执行真实副作用。
- 权限拒绝时将拒绝结果回填给模型。
- 工具异常会被包成 tool_result，避免消息协议断裂。

## 普通工具调度

`toolOrchestration.ts` 中的 `runTools()` 会按并发安全性分批执行工具：

- 连续的 concurrency-safe 工具可以并发。
- 非 concurrency-safe 工具必须单独串行。
- 读类工具通常可以并发。
- 写类、shell、副作用类工具通常不能随意并发。
- 并发工具的 context modifier 先排队，再按工具顺序应用。

这套规则防止写操作、shell、状态修改类工具在同一批次中互相干扰。

## 流式工具执行

`StreamingToolExecutor` 支持在模型流式输出尚未完全结束时开始执行工具。它的主要职责包括：

- 工具被流式发现后立即入队。
- 并发安全工具可同时执行。
- 非并发工具需要独占。
- 结果必须按工具出现顺序对外产出。
- 进度消息可以提前产出。
- streaming fallback 时丢弃旧工具结果。
- 用户中断时为未完成工具生成合成错误。
- 某个并发工具失败时取消兄弟工具。

这套机制用更高复杂度换取更低延迟。

## 权限系统

当前权限判断通过 `CanUseToolFn` 完成。它不是简单 allow/deny，而是一套多来源决策系统：

- 配置规则。
- permission mode。
- 工作目录限制。
- classifier。
- hook。
- 用户交互确认。
- coordinator worker 自动检查。
- swarm worker 转发。
- bridge/channel 回调。
- abort 和取消。

结果语义包括：

- `allow`：允许执行，可携带 updated input。
- `deny`：拒绝执行，生成拒绝结果。
- `ask`：需要用户、主线程或协调器进一步决策。

## Hook 与工具执行

当前工具执行中包含 pre/post hook：

- pre tool use hook 可能允许、拒绝或修改执行。
- post tool use hook 可以记录结果或触发后续行为。
- hook 进度可作为 progress message 出现在流中。
- hook 和权限都可能影响最终工具执行。

hook 在当前项目中既是自动化策略扩展点，也是权限与审计链路的一部分。

## MCP 工具

当前 MCP 工具被包装成普通工具进入模型请求和工具调度。执行时会识别 `mcp`__ 前缀，根据 server connection 找到 transport 类型、base URL、server scope 等。

MCP 在工具链路中的角色包括：

- 外部 server 工具进入工具列表。
- MCP tool call 按普通 tool_use/tool_result 协议执行。
- MCP auth、elicitation、server pending 状态进入工具上下文或权限交互链路。

## 当前实现的复杂点

- 单一 `tools.ts` 管理所有工具和 feature flag。
- 工具上下文包含 UI、analytics、state、storage、MCP、agent 等多类能力。
- 权限 hook、UI prompt、classifier、bridge callback 混在 React hook 和权限工具链路中。
- tool execution 同时负责 telemetry、MCP metadata、permission、hook、progress 和结果构造。

