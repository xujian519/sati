# Config 与 Model 模块集成

本文定义当前阶段 `agent` 和 `model` 模块如何消费 `polit/config`，并说明 `agent.model` 如何管理默认厂商/模型。adapter 接入仍是未来扩展。

## 集成原则

当前阶段遵循同一原则：

- 只消费 `PolitConfigSnapshot` 或自己的配置段。
- 不直接读取 `${PolitHome}/politdeck.yaml`。
- 不直接读取环境变量作为配置来源。
- 不保存可变配置对象引用。
- 不在模块内部自行合并 CLI 参数。
- 对配置段做必要的模块内语义校验。

推荐模式：

```text
config runtime creates snapshot
  -> model receives snapshot.config.model
  -> agent receives snapshot.config.agent model selection
  -> createModelRuntime(snapshot.config.model)
  -> request metadata may include snapshot version
```

## Model

`model` 模块消费：

```text
snapshot.config.model
```

职责：

- 校验 provider 协议。
- 创建绑定 `ModelConfig` 的 `ModelRuntime`。
- 校验 `agent.model` 指向的 provider/model 是否存在。
- 根据 model capabilities 决定 tool、streaming、thinking、JSON schema 等能力。
- 根据 multimodal constraints 校验 canonical content blocks。

热重载语义：

- 当前模型请求不切换。
- 后续模型请求使用新配置。
- API key、headers、timeout、URL 变化只影响使用新 snapshot 创建或选择的 runtime。
- model list 和 capabilities 变化需要调用方用新 snapshot 创建或选择新的 `ModelRuntime`。

`model` 当前暴露：

```text
createModelRuntime(snapshot.config.model, options)
```

避免在请求中重新访问全局状态。

## Model Request 绑定

当前 canonical request 没有专用配置绑定字段。调用方需要排查“请求使用了哪一份配置”时，可以把以下信息放入 `CanonicalModelRequest.metadata`：

```text
configSnapshotVersion
contentHash
providerId
modelId
```

这些信息用于排查“请求使用了哪一份配置”，但不能把 API key、headers 中的认证字段或完整配置写入日志。

## Provider Registry

当前 `ModelProviderRegistry` 不是按 snapshot 编译出的 provider 实例表，而是一个静态协议 adapter registry：

```text
ModelProviderRegistry
  get(protocol: "anthropic" | "openai") -> ModelProviderAdapter
  list() -> ModelProviderAdapter[]
```

provider 和 model list 保存在 `ModelConfig` 中，由 `createModelRuntime(config)` 绑定。默认 provider/model 和 fallback model 的选择属于目标 `agent` 段，由 `agent.model` / `agent.fallbackModel` 解析后传给 `AgentRuntimeConfig`。

## Model 二次校验

总 schema 只能校验配置结构。`model` 模块仍需做模型语义校验：

- protocol adapter 是否存在。
- provider URL 是否能被 adapter 接受。
- API key 是否已解析为可用 secret 或 secret handle。
- `agent.model` 指向的 model 是否可被当前 provider 使用。
- `agent.fallbackModel` 是否指向可用 provider/model。
- capabilities 是否满足 request builder 需要。
- multimodal constraints 是否能约束 canonical content block。
- provider headers 是否包含不支持或冲突的字段。

## Adapters

未来 CLI、TUI、SDK、Web、Remote adapter 都应通过 `polit/config` 注入覆盖项。

### CLI

CLI flag 示例：

```text
--model
--provider
--api-key-env
```

这些 flag 不应直接改 `model` 模块，也不作为新的 `PolitConfigSource.kind`。当前阶段如果调用方需要覆盖配置，应转换为已实现的受控 env override 或要求用户写入项目级配置。

### SDK

SDK options 示例：

```text
Agent.create({
  model
})
```

SDK 需要能拿到配置诊断，方便调用方在 headless 环境展示错误。

### UI/TUI

未来 UI/TUI 可以订阅 config events，用于提示：

- 配置已重载。
- 配置重载失败。
- 某些变更需要重启。
- 默认模型、provider 或认证引用发生变化。

UI 不应保存配置事实来源。设置页保存后仍由 config loader 重新读取并发布 snapshot。

## Agent

当前 `AgentRuntimeConfig` 仍由调用方构造；`PolitConfigSnapshot` 已提供解析后的 `agent` model selection。建议调用方通过一个明确的编译步骤生成 `AgentRuntimeConfig`：

```text
PolitConfigSnapshot
  -> parse snapshot.config.agent.model
  -> validate against snapshot.config.model.providers
  -> AgentRuntimeConfig
  -> createAgentSession()
```

映射原则：

- `agent.model` 是 agent provider/model 默认值的单一事实来源，格式为 `provider/model`。
- `agent.fallbackModel` 是 fallback provider/model 的单一事实来源，格式为 `provider/model`。
- `model` 段只提供 provider/model 定义，不再提供默认模型选择字段。
- `AgentRuntimeConfig.permissionMode` 与 `permissionContext.mode` 必须保持一致；如果配置系统提供默认权限模式，编译时要同时写入两处。
- `maxContextMessages` 应优先来自 `context` 段；`agent` 段只保存 loop 行为，不重复定义 token budget。
- `env`、`now`、`uuid`、`auditRecorder` 等依赖注入项不应进入 YAML。

## 其他运行时模块

tool、permission、context、session/transcript 当前仍由调用方 runtime wiring、session state 或 `polit/paths` 派生路径管理。本轮 `polit/config` 只把默认模型选择收敛到 `agent.model` / `agent.fallbackModel`，不在本文定义这些模块的 YAML 字段。

## Config Facade

当前给上层暴露的 facade 是 `PolitConfigStore`：

```text
PolitConfigStore
  getSnapshot()
  reload(reason)
  subscribe(listener)
  getDiagnostics()
  startWatching(options)
```

不要暴露 loader 内部细节给业务模块。

## 生效范围矩阵

```text
配置项                         默认生效范围
agent.model                    next-request
agent.fallbackModel            next-request
model.provider.url             next-request
model.provider.apiKey          next-request
model.provider.timeoutMs       next-request
model.provider.headers         next-request
model.provider.retry           next-request
model.provider.models          next-request
model.capabilities             next-request
model.multimodal               next-request
POLIT_HOME                     当前不进入 snapshot diff；运行中变化需重启
```

当前实现采用保守策略：`agent` 和 `model` 业务变更只对使用新 snapshot 创建或选择的后续 runtime/request 生效。默认模型选择由 `agent.model` / `agent.fallbackModel` 管理。`POLIT_HOME` 由环境变量控制，不属于 YAML 配置；运行中变化需要重启，当前不会通过 `classifyConfigChanges()` 自动报告 `restart-required`。

## 分册关系

本文件只描述跨模块集成模式。各模块的目标配置字段和约束分别见：

- `[06-agent-and-session-config.md](./06-agent-and-session-config.md)`
- `[07-config-change-taxonomy-beyond-model.md](./07-config-change-taxonomy-beyond-model.md)`

## 禁止模式

实现时应避免：

- 模块启动时读取一次配置后永远不更新。
- 每次模型请求都重新读 YAML。
- 在 `model` 模块内直接访问 process env。
- 让 CLI flag 绕过 config snapshot。
- 在日志中记录未脱敏配置。
- 在热重载时修改已发出的模型请求。

`polit/config` 的价值在于让运行时所有入口共享同一份配置事实来源。