# 新项目产品规格

本文把当前项目中围绕 agent loop 的能力抽象为新产品规格。它不是旧项目目录说明，也不是 MVP 计划，而是新项目应提供的目标产品能力定义。

## 产品定位

新项目名为 `PilotDeck`，是一个面向开发者的 agent runtime 产品，提供可嵌入、可扩展、可审计的代码智能体运行时。

它的核心价值是：

- 让用户以自然语言驱动代码理解、编辑、搜索、执行和验证。
- 让模型通过受控工具访问工作区、shell、网络、MCP 和子 agent。
- 在多轮会话中保存上下文、执行状态和可恢复历史。
- 在可交互 UI、CLI、SDK/headless、远端执行之间共享同一套 agent loop。

## 核心用户场景

### 代码问答

用户可以询问代码库结构、文件含义、调用链、设计原因和潜在问题。agent 应能读取文件、搜索代码、综合上下文并回答。

### 代码修改

用户可以要求 agent 修改文件。agent 应能搜索、读取、规划、执行编辑、解释变更，并在需要时运行验证命令。

### 命令执行

用户可以要求 agent 运行 shell 命令。agent 应根据权限策略判断是否允许、是否需要确认，并将输出纳入后续推理。

### 多工具协作

同一轮 turn 中，agent 可以连续调用多个工具。例如先搜索文件，再读取文件，再编辑，再运行测试，再总结。

### 会话延续

用户可以在同一会话内多次提交消息。agent 应保留历史、工具结果、文件状态和关键上下文。

### 会话恢复

进程退出或用户重新打开项目后，可以恢复先前会话，并继续从已记录 transcript 推理。

### 子 agent / 背景任务

agent 可以委派独立任务给子 agent 或后台任务，并将结果汇总回主会话。

### 外部工具扩展

产品应支持 MCP、插件、技能或其他扩展机制，使外部系统以工具、资源、hook 或 prompt fragment 的形式参与 agent loop。

## 核心产品对象

### AgentSession

代表一个可持续多 turn 的会话。

职责：

- 保存消息历史。
- 保存会话配置。
- 管理 turn。
- 暴露事件流。
- 提供 resume。
- 记录 usage、cost、权限拒绝和错误。

### Turn

代表用户提交一次输入后，agent 从接收输入到完成响应的完整过程。一个 turn 内可能包含多次模型请求和多次工具执行。

### ModelRequest

代表一次发送给模型的请求，包含 messages、system prompt、user context、tool schemas、thinking config、model config、task budget 和 runtime metadata。输入附件、IDE 上下文、memory 和 MCP resources 应先由 context 模块投影为 messages 中的内容块，不作为 model request 的独立 `attachments` 字段存在。

全局配置默认从 `PilotConfigPath` 指向的 `~/.pilotdeck/pilotdeck.yaml` 读取，模型连接配置位于该 YAML 的 `model` 段，可由项目级配置覆盖。当前阶段只要求支持 URL、API key、协议格式、默认模型、model list、model 级 capabilities 和 multimodal input constraints，暂不要求 OAuth 登录等复杂认证流程。

### ToolCall

代表模型请求执行的工具调用，包含 tool name、tool input、tool use id、parent assistant message、permission decision、progress、result 和 error。

### ContextSnapshot

代表一次模型请求前的上下文快照，包含有效消息窗口、compact 状态、tool result budget 处理结果、memory/attachment/resource 注入结果、token 估算和预算状态。

### Transcript

代表可持久化、可恢复的会话记录。它不是简单 UI 日志，而是恢复 agent loop 所需的事实来源。

### PilotDeck 全局路径

`PilotDeck` 需要集中管理用户级配置、记忆、会话、缓存和扩展目录。全局路径常量统一使用 `Pilot` 前缀，默认根目录为 `~/.pilotdeck`。

建议至少定义：

```text
PilotHome = ~/.pilotdeck
PilotConfigPath = ~/.pilotdeck/pilotdeck.yaml
PilotMemoryDir = ~/.pilotdeck/memory
PilotSessionDir = ~/.pilotdeck/sessions
PilotCacheDir = ~/.pilotdeck/cache
PilotExtensionDir = ~/.pilotdeck/extensions
```

这些路径由专门的 path/config 模块集中解析，业务模块不应散落拼接用户主目录路径。

## 用户可见能力

### 对话能力

产品应支持：

- 流式输出。
- 多轮会话。
- 中断当前 turn。
- 继续会话。
- 重放历史。
- 显示工具进度。
- 显示权限请求。
- 显示 compact 或上下文治理提示。

### 工具能力

产品应提供内置工具：

- 文件读取。
- 文件写入。
- 文件编辑。
- 代码搜索。
- glob 搜索。
- shell 执行。
- web fetch / web search。
- todo / task 状态。
- MCP tool。
- 子 agent。

每个工具必须有 schema、描述、权限策略、并发策略、输入校验、错误格式和进度事件。

### 权限能力

产品应支持：

- default 权限模式：按配置规则、工作区边界、工具类型和 allow/deny/ask 规则判断工具调用。
- plan 权限模式：偏向计划生成，限制直接副作用工具执行，并配合退出计划机制进入执行阶段。
- bypassPermissions 权限模式：显式绕过或弱化权限确认，使工具执行阻塞最少，同时保留模式标识和审计能力。
- 自动模式。
- always allow / always deny / always ask。
- 工作区目录限制。
- shell 危险命令识别。
- 文件写入确认。
- headless 非交互策略。
- 子 agent 权限转发。

权限结果应是标准协议：

```text
allow(updatedInput?)
deny(reason)
ask(request)
cancel(reason)
```

### 上下文能力

产品应支持：

- 系统提示词组合。
- 用户上下文注入。
- 工作区上下文。
- memory 文件。
- 附件。
- MCP resources。
- 技能/插件 prompt fragment。
- token 预算。
- 工具结果裁剪。
- 自动压缩。
- 溢出恢复。

### 扩展能力

产品应支持扩展贡献：

- tools。
- commands。
- hooks。
- prompt fragments。
- resources。
- output renderers。
- permission rules。

扩展不应直接修改 agent loop，只能通过稳定接口贡献能力。

## 等价能力要求

新项目中的 agent、context、tool、extension 模块必须保证与原项目核心能力一致。这四部分在原项目中是最优秀的部分，重写目标是等价实现，而不是重新设计产品行为。

- agent：保持多 turn loop、tool_use/tool_result 回填、streaming event、interrupt/recovery、subagent 嵌套等行为一致。
- context：保持 system/user/system context 组合、memory、attachments、tool result budget、compact boundary、microcompact、autocompact、overflow recovery 等能力一致；attachments 由 context 解析/投影进 canonical messages，不作为 model 模块的独立输入。
- tool：保持工具 schema、工具注册、输入校验、串并行调度、streaming tool execution、progress、错误回填、MCP tool 接入等能力一致。
- extension：保持 plugins、skills、hooks、commands、MCP contributions、prompt fragments、permission rules 等贡献模型一致。

## 运行时事件规范

新项目把事件流作为产品 API。事件按职责分为三层：

### 内部 Agent 事件 (`AgentEvent`)

`AgentEvent` 是 agent session / turn / tool / model 内部的完整事件流，用于 transcript、调试、子系统通信和 Gateway 投影。当前实现定义于 `src/agent/protocol/events.ts`：

```text
session_started          会话创建
session_ended            会话结束（含 reason）
session_aborted          会话被 abort

turn_started             turn 开始
input_accepted           用户输入已被接受
user_prompt_submitted    用户 prompt 提交
setup_completed          Setup 生命周期完成

model_request_started    模型请求开始（含 model、provider）
model_event              模型流式子事件（CanonicalModelEvent）
instructions_loaded      系统提示/指令加载完成

assistant_message        助手消息完整块
tool_calls_detected      模型产出工具调用
pre_tool_execute         工具执行前
post_tool_execute        工具执行后（含 success）
permission_requested     工具权限请求
permission_denied        工具权限拒绝（含 reason）
tool_result              工具结果
tool_results_projected   工具结果投影进上下文

mode_change_requested    权限模式切换请求
stop_requested           模型停止请求
stop_failure             Stop hook 失败

compact_started          上下文压缩开始（含 trigger、preTokens）
compact_completed        上下文压缩完成（含 status、postTokens）

subagent_started         子 agent 启动
subagent_completed       子 agent 完成（含 durationMs）

elicitation_requested    工具向用户提问（Elicitation）
elicitation_resolved     Elicitation 已回答或取消

turn_continued           turn 内继续下一轮循环（含 reason）
turn_completed           turn 完成
turn_failed              turn 失败
```

### 客户端 Gateway 事件 (`GatewayEvent`)

`GatewayEvent` 是面向外部消费者（Web UI、CLI、TUI、SDK）的精简事件流。`InProcessGateway.mapAgentEvent` 从 `AgentEvent` 投影到 `GatewayEvent`，部分内部事件投影为 `agent_status`，部分被丢弃。当前定义于 `src/gateway/protocol/types.ts`：

```text
turn_started                 turn 开始（含 runId）
assistant_text_delta         助手文本流
assistant_thinking_delta     助手 thinking 流
tool_call_started            工具调用开始
tool_call_finished           工具调用完成（含 resultPreview、errorCode）
tool_result_detail_available 工具结果详情可用
permission_request           权限请求（等待 host 决定）
elicitation_request          Elicitation 问题推送
elicitation_cancelled        Elicitation 被取消
structured_output            结构化输出
plan_mode_changed            权限模式变更
config_changed               配置热更新（含 changedPaths、changeClasses）
worktree_created             Worktree 创建
worktree_removed             Worktree 移除
turn_completed               turn 完成（含 usage、finishReason）
agent_status                 内部状态透传（event + detail）
error                        错误（含 code、recoverable）
```

### 跨会话 / 进程级事件

以下事件不绑定单个 agent session，而是作用于整个 Gateway 进程或项目：

- **`config_changed`**：通过 `WsNotificationFrame` 广播给所有连接的客户端，`ConfigChange` 生命周期 hook 使用 `sessionId: ""` dispatch，不绑定具体会话。
- **`RouterEvent`**：路由决策、fallback、重试等审计事件，写入 `router-events.jsonl`，不回流到 agent loop。
- **`AlwaysOnPhaseEvent`**：Always-On 任务的发现/规划/执行/报告阶段事件，跨多个合成 sessionKey 编排。
- **`PilotConfigReloadEvent`**：配置文件变化通知，由 `PilotConfigStore.subscribe` 分发给监听者。
- **`ExtensionWatchEvent`**：扩展目录文件变化事件，触发插件/hook 热重载。

所有 UI、CLI、SDK、日志、测试都应消费同一套 Gateway 事件；内部子系统可订阅更细粒度的 `AgentEvent`。

## 非功能要求

### 可测试性

agent loop 应可用 fake model 和 fake tools 做确定性测试。模型输出、工具结果、时间、UUID、文件系统、权限决策和 transcript 都应可替换。

### 运行时与包管理

当前根项目以 `package.json` 为准，使用 npm scripts 驱动 TypeScript build 与 Node test runner：`npm run build`、`npm test`。历史 parity probe 如果需要执行 vendored 旧项目脚本，可以在对应文档中单独声明 `bun run` / `bun test`；新项目源码和 CI 不应假设 Bun 是唯一运行时。

### 可恢复性

任意 turn 至少在以下节点可恢复：

- 用户输入已接受但模型未返回。
- assistant 已输出部分内容。
- 工具调用已产生。
- 工具结果已产生。
- compact boundary 已产生。

### 可扩展性

新工具、新模型、新 UI、新存储后端不应要求修改 agent loop 内核。

### 可观测性

每个 turn 应可追踪模型请求次数、工具调用次数、工具耗时、权限决策、上下文压缩、token 和费用、错误与恢复路径。

### 安全性

工具执行必须受限于工作区边界、权限策略、shell 命令风险、文件写入确认、网络访问策略和 MCP server 信任策略。

## 产品能力边界

新项目的核心不是复制旧 CLI，而是提供可复用 agent runtime。

CLI、TUI、Web、SDK、远端执行都只是 adapter。核心功能一致应定义为：

- 同样支持模型驱动的多轮工具调用。
- 同样支持工具权限、安全和回填。
- 同样支持上下文治理和恢复。
- 同样支持扩展工具和外部资源。
- 同样支持流式事件和多客户端消费。

旧项目中的具体命令名、内部 feature flag、ant-only 分支、历史兼容 shim 不应成为产品规格的一部分，除非它们对应明确的用户价值。