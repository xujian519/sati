# Agent 与 Session 配置

本文定义 `agent` 与 session 创建相关配置的边界。当前 `PolitConfig` 已包含 `agent.model` 和 `agent.fallbackModel`，用于统一管理默认模型选择；`AgentRuntimeConfig` 的其他参数仍由调用方构造并注入。

## 当前实现事实

`AgentRuntimeConfig` 当前包含：

```text
provider
model
cwd
systemPrompt?
maxOutputTokens?
temperature?
thinking?
toolChoice?
fallbackProvider?
fallbackModel?
maxContextMessages?
stopOnStructuredOutput?
permissionMode
permissionContext
env?
maxResultBytes?
metadata?
```

`AgentLoopInput` 还包含每次 run 的 `sessionId`、`turnId`、`messages`、`maxTurns?` 和 `abortSignal?`。其中 `sessionId`、`turnId`、`messages`、`abortSignal` 是一次调用的运行时事实，不应进入 YAML 配置。

## 目标配置段

`agent` 段只承载默认模型选择，不承载 provider URL、API key、capabilities 或 loop 行为参数：

```yaml
agent:
  model: anthropic-main/claude-sonnet-4-5
  fallbackModel: anthropic-main/claude-haiku-4-5
```

字段值使用 `provider/model` 格式，解析时只需要按第一个斜杆拆分即可。`provider` 部分必须匹配 `model.providers` 中的 provider id，`model` 部分必须存在于该 provider 的 `models` map。

当前 loader 会解析并校验该段。当前源码里的 `AgentRuntimeConfig` 仍需要调用方传入拆分后的 `provider` 和 `model`。

## Model 默认值映射

`agent` 段是默认厂商/模型选择的事实来源：

- `agent.model` 表示默认 provider/model。
- `agent.fallbackModel` 表示 fallback provider/model。
- `model` 段只描述 provider、model list、连接参数、认证、capabilities 和 multimodal constraints。
- 默认模型选择不再放在 `model` 段。

编译为 `AgentRuntimeConfig` 时：

```text
agent.model: anthropic-main/claude-sonnet-4-5
  -> provider: anthropic-main
  -> model: claude-sonnet-4-5

agent.fallbackModel: anthropic-main/claude-haiku-4-5
  -> fallbackProvider: anthropic-main
  -> fallbackModel: claude-haiku-4-5
```

如果 `agent.fallbackModel` 缺失，则不启用 fallback recovery policy，除非调用方通过 session/runtime override 显式注入。

## Permission 映射

`AgentRuntimeConfig.permissionMode` 与 `AgentRuntimeConfig.permissionContext.mode` 必须一致，但它们不属于目标 `agent` 段。权限模式仍由调用方、session state 或未来独立 permission schema 管理，session 内工具结果触发的 mode change 不应写回 YAML。

## Context 映射

`maxContextMessages` 目前由 `AgentRuntimeConfig` 传给 `AgentContextRuntime.prepareForModel()`，但它不属于目标 `agent` 段。`agent` 段只管理默认模型选择；context budget 仍由调用方或未来独立 context schema 管理。

## Session 创建

`createAgentSession()` 当前接收：

```text
sessionId
config: AgentRuntimeConfig
dependencies
transcript?
projectStorage?
initialState?
replayEvents?
```

其中：

- `sessionId`、`initialState`、`replayEvents` 是 session state / resume 输入，不属于全局配置。
- `dependencies.model`、`tools.registry`、`tools.scheduler`、`context` 是 runtime wiring，不直接写入 YAML。
- `projectStorage` 可以由 future `session` 配置和 `polit/paths` 派生。

## 热重载语义

- `agent.model`：只影响后续模型请求或后续新建的 `AgentRuntimeConfig`，不改写已构造完成的 request。
- `agent.fallbackModel`：只影响后续 recovery policy；已发生 fallback 的 loop 不被重置。
- `permissionMode`：若来自配置默认值，只影响新 session；运行中 mode change 是 session state。

## 不进入配置的内容

以下内容不应进入 `politdeck.yaml`：

- 当前消息列表、tool call、tool result、model response。
- abort signal、时间函数、UUID 生成器。
- audit recorder 实例、transport 实例、scheduler 实例。
- 用户在一次 permission prompt 中做出的临时选择。
- transcript replay 事件内容。
