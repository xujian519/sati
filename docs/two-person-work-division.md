# 两人阶段分工

本文基于 `rewrite-plan/02-rewrite-project-report.md` 和 `model/` 模块文档，约定当前阶段两个人的工作边界。目标不是制定长期路线图，而是让 `model` 与 `tool/permission` 两条主线可以并行推进，并为后续 `agent loop` 集成预先固定必要接口。

## 分工原则

新项目采用以 `agent` 为中心的分层架构：

```text
agent
  -> model
  -> context
  -> tool
  -> permission
  -> session
  -> extension
```

当前阶段不建议让第二个人同时承担 `agent`、`context`、`tool`、`permission`、`session` 的完整实现。更稳妥的方式是：

- 一个人继续负责 `model` 和与模型配置直接相关的基础配置。
- 另一个人聚焦 `tool + permission` 的第一版运行时。
- `agent/context/session/extension/adapters` 暂时只预定接口或保留占位，不作为当前阶段的完整交付目标。

## 人员 A：Model 负责人

人员 A 继续负责已经开始推进的 `model` 部分，同时承担与模型配置直接相关的 `pilot/paths`、`pilot/config` 最小能力。

### 负责范围

```text
src/pilot/
  paths/
  config/

src/model/
  config/
  protocol/
  providers/
  request/
  response/
  streaming/
  errors/

tests/model/
```

### 当前阶段任务

- 定义 `PilotHome`、`PilotConfigPath` 等全局路径常量。
- 读取 `~/.pilotdeck/pilotdeck.yaml`，并把其中的 `model` 配置段交给 `model` 模块校验和消费。
- 定义 `CanonicalModelRequest`、`CanonicalMessage`、`CanonicalContentBlock`。
- 定义 `CanonicalToolSchema`、`CanonicalToolCall`、`CanonicalToolResult`。
- 定义 `CanonicalModelEvent`、`CanonicalModelResponse`、`CanonicalUsage`、`CanonicalModelError`。
- 实现 Anthropic 协议的 request、response、stream 归一化。
- 实现 OpenAI-compatible 协议的 request、response、stream 归一化。
- 实现 provider URL、API key、headers、timeout、model list、capabilities、multimodal input constraints 的配置校验。
- 实现 `${ENV_NAME}` API key 解析。
- 实现 provider/model capabilities 合并。
- 实现 provider 错误归一化。
- 编写 `tests/model/` 下的配置、请求构造、响应解析、stream 事件和错误归一化测试。

### 暂不负责

- OAuth、浏览器登录、远端 token 同步。
- 工具执行、权限判断、文件读写、shell。
- 上下文压缩、memory、attachments。
- transcript、resume、replay。
- CLI/TUI/Web/SDK adapter。

## 人员 B：Tool/Permission 负责人

人员 B 当前阶段只负责 `tool + permission` 第一版，不承担完整 agent loop。该方向的目标是把模型返回的 `tool_call` 变成稳定的工具执行链路和统一 `tool_result`。

### 负责范围

```text
src/tool/
  registry/
  scheduler/
  execution/
  builtin/

src/permission/
  policy/
  decision/
  audit/

tests/tool/
tests/permission/
```

### 当前阶段任务

- 定义 `ToolDefinition`、`ToolCall`、`ToolResult`、`ToolRuntimeContext`。
- 实现 `ToolRegistry`，支持按工具名查找工具。
- 实现工具输入 schema 校验。
- 实现工具不存在时的标准错误 `tool_result`。
- 实现输入非法时的标准错误 `tool_result`。
- 定义 `PermissionMode`，当前至少覆盖 `default`、`plan`、`bypassPermissions`。
- 定义 `PermissionDecision`：`allow`、`deny`、`ask`、`cancel`。
- 实现最小 `PermissionRuntime.decide()`。
- 实现工具执行前必须经过权限判断的链路。
- 实现最小顺序调度器，先不做复杂 streaming tool execution。
- 实现基础 audit record 结构，先记录权限模式、工具名、决策结果和原因。
- 编写 `tests/tool/` 和 `tests/permission/`，覆盖工具查找、输入校验、权限 allow/deny、错误 `tool_result`。

### 当前阶段可以只做骨架的内置工具

- read file。
- glob。
- grep/search。

这些工具第一阶段可以优先定义接口、schema 和测试假实现，不要求立刻覆盖完整真实文件系统行为。

### 暂不负责

- streaming tool execution。
- MCP tool adapter。
- subagent tool。
- shell 危险命令 classifier。
- 文件写入、文件编辑的完整权限细节。
- interactive permission UI。
- remote/bridge permission callback。
- hooks、plugins、skills。

## 暂缓完整实现的模块

以下模块当前阶段不分配为完整主线，只预定接口或保留最小占位：

- `agent`：先约定如何调用 `ModelRuntime`、`ToolRuntime`、`PermissionRuntime`，暂不完整实现多 turn 状态机。
- `context`：先约定 `prepareForModel()`、`applyToolResults()` 等接口，暂不实现完整 compact、memory、attachments。
- `session`：先约定 `TranscriptStore` 接口，暂不实现完整 resume、replay、tombstone、migration。
- `extension`：等待 tool、permission、context、session 接口稳定后再实现 contribution model。
- `adapters`：暂不实现完整 CLI/TUI/Web/SDK，只允许后续添加极薄 demo 来验证事件流。

## 需要预定的接口

这些接口需要两个人在编码前先达成一致。接口可以在实现中调整命名，但语义应保持稳定。

### ModelRuntime

```ts
interface ModelRuntime {
  stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent>
  complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse>
  getCapabilities(providerId: string, modelId: string): ModelCapabilities
}
```

`agent` 以后只依赖该接口，不直接依赖 Anthropic/OpenAI SDK 类型。

### ToolRuntime

```ts
interface ToolRuntime {
  execute(call: CanonicalToolCall, context: ToolRuntimeContext): Promise<ToolResult>
}
```

第一版先返回 `Promise<ToolResult>` 即可。后续如果要支持 streaming tool execution，可以再扩展为 async iterable。

### PermissionRuntime

```ts
type PermissionDecision =
  | { type: "allow"; updatedInput?: unknown }
  | { type: "deny"; reason: string }
  | { type: "ask"; request: PermissionRequest }
  | { type: "cancel"; reason: string }

interface PermissionRuntime {
  decide(call: ToolCall, context: PermissionContext): Promise<PermissionDecision>
}
```

工具执行器不得绕过 `PermissionRuntime`。

### ContextRuntime

```ts
interface ContextRuntime {
  prepareForModel(turnState: TurnState): Promise<ModelContext>
  applyToolResults(results: ToolResult[], turnState: TurnState): Promise<TurnState>
  recoverFromModelError(error: CanonicalModelError, turnState: TurnState): Promise<RecoveryDecision>
}
```

当前阶段可以只保留接口，不实现完整上下文治理。

### AgentSession

```ts
interface AgentSession {
  submit(input: AgentInput, options?: SubmitOptions): AsyncIterable<AgentEvent>
  abort(reason?: string): void
  snapshot(): SessionSnapshot
}
```

`AgentSession` 是后续整合两条主线的入口，但当前阶段不要求完整实现。

### TranscriptStore

```ts
interface TranscriptStore {
  append(event: AgentEvent): Promise<void>
  read(sessionId: string): AsyncIterable<AgentEvent>
}
```

当前阶段只需预留，不急于实现完整 resume 语义。

## 集成边界

两条主线最终在 `agent loop` 汇合：

```text
AgentLoop
  -> ContextRuntime.prepareForModel()
  -> ModelRuntime.stream()
  -> detect tool_call
  -> PermissionRuntime.decide()
  -> ToolRuntime.execute()
  -> ContextRuntime.applyToolResults()
  -> continue or complete
```

当前阶段只要求 `model` 和 `tool/permission` 能分别通过自己的测试。等这两部分稳定后，再开始实现 `AgentLoop` 的真实状态机。

## 当前阶段不做的事情

- 不先做完整 UI、TUI、Web 或 SDK adapter。
- 不先做完整 extension/plugin/skill/hook 系统。
- 不先做 MCP tool adapter。
- 不先做 subagent。
- 不先做复杂 streaming tool execution。
- 不把 Anthropic/OpenAI SDK 类型泄漏到 `agent`、`tool`、`permission`。
- 不在 `model` 模块里处理工具执行、权限、上下文压缩或 transcript。

