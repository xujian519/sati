# 上下文与会话运行时分析

本文只分析当前项目中围绕 agent loop 的状态能力：输入处理、系统提示词、上下文构造、压缩、session transcript、恢复、技能、插件、MCP resources、文件状态和中断。

主要参考：

- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/QueryEngine.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/query.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/processUserInput/processUserInput.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/queryContext.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/messages.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/services/compact/*`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/sessionStorage.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/memdir/*`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/services/mcp/*`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/skills/*`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/plugins/*`

## 上下文窗口构造

agent loop 每次调用模型时，发送的是动态构造的上下文窗口，而不是用户刚输入的一句话。

上下文包含：

- 历史消息。
- system prompt。
- user context。
- system context。
- 工具 schema。
- MCP 工具和资源。
- 技能和插件。
- memory 文件。
- 附件。
- compact 后的摘要。
- tool result budget 处理后的结果。
- 权限和工作目录信息。
- 当前模型、thinking、fast mode、effort 等运行配置。

## 输入处理

`QueryEngine.submitMessage()` 在进入 `query()` 前调用 `processUserInput()`。这一步可能产生：

- 普通用户消息。
- 附件消息。
- slash command 结果。
- 本地命令输出。
- 模型覆盖。
- allowed tools 规则更新。
- 是否需要真正调用模型。

这使当前项目区分了“用户输入被接受”和“本轮是否进入模型请求”两个阶段。

## 系统提示词和用户上下文

当前项目通过 `fetchSystemPromptParts()` 获取：

- default system prompt。
- user context。
- system context。

随后再叠加：

- custom system prompt。
- memory mechanics prompt。
- append system prompt。
- coordinator context。
- working directories。
- MCP client 信息。

这部分决定模型在本轮看到的行为规则和环境事实。

## 消息模型

当前消息体系包含：

- user message。
- assistant message。
- system message。
- attachment message。
- tombstone message。
- compact boundary。
- progress message。
- tool result message。
- local command message。
- synthetic message。

agent loop 对消息协议非常敏感：

- 每个 `tool_use` 必须对应一个同 ID 的 `tool_result`。
- thinking block 有保留和签名约束。
- tombstone 用于移除 streaming fallback 后的孤儿消息。
- compact boundary 用于 resume 和上下文裁剪。
- SDK/headless 输出和 transcript 持久化需要不同映射。

## 上下文预算和压缩

当前项目在每次模型请求前做多层上下文治理：

- `getMessagesAfterCompactBoundary()`：只取 compact boundary 之后的有效上下文。
- `applyToolResultBudget()`：限制工具结果总量。
- snip：按历史片段裁剪。
- microcompact：局部压缩或 cache edit。
- context collapse：把部分上下文折叠成可投影视图。
- autocompact：触发摘要型压缩。
- reactive compact：在 prompt too long 等错误后恢复。
- max output tokens recovery：处理输出超限恢复。
- blocking limit：在不能自动处理时给出错误。

这些策略共同保证长会话不会直接因为上下文窗口超限而失效。

## Session transcript

`QueryEngine` 在进入模型请求前写入用户消息 transcript。代码注释说明这样做是为了避免进程在模型响应前被杀后，resume 找不到用户刚提交的消息。

transcript 的职责包括：

- 记录用户消息。
- 记录 assistant 消息。
- 记录 tool_result。
- 记录 compact boundary。
- 支持 flush。
- 支持 resume。
- 支持重放为 SDK/UI 可消费事件。
- 支持 tombstone 或逻辑删除。

写入时机与恢复正确性强相关。

## 恢复与 replay

当前项目支持：

- 从 transcript 重建消息历史。
- compact 后恢复。
- SDK replay user messages。
- local command output 转换。
- 缺失 tool_result 或 orphaned permission 等异常状态处理。

resume 不只是 CLI 功能，而是会话运行时能力。

## Memory、skills、plugins

当前项目在进入 turn 前加载 memory prompt、技能和插件：

- memory 影响 system prompt 和附件。
- skills 可能提供 slash command 或工具行为提示。
- plugins 可能提供命令、技能、hook、输出样式等。

这些能力不一定直接执行 loop，但会改变模型看到的上下文、工具和命令集合。

## MCP resources

MCP 在当前项目中不仅提供工具，也提供 resources。资源可以进入 prompt、工具上下文或 UI 列表。

MCP 相关状态包括：

- server connection。
- tools。
- resources。
- auth。
- elicitation。
- pending server 状态。

## 中断与取消

当前项目大量使用 `AbortController`：

- 用户中断模型流。
- 工具执行中断。
- streaming tool executor 为兄弟工具创建 child abort controller。
- permission check 可被 abort。
- interrupt behavior 可由工具定义决定。

不同中断路径会映射成不同的消息、错误或 tool_result。

## 当前实现的复杂点

- 上下文治理策略多，且顺序敏感。
- transcript 写入时机与 resume 正确性强耦合。
- SDK/headless、REPL、子 agent 对同一消息历史有不同投影方式。
- memory、skills、plugins、MCP 同时影响上下文、工具和命令集合。
- 中断、fallback、context overflow 等恢复路径与主 loop 交织。