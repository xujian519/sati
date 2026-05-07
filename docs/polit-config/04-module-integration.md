# Config 与 Model 模块集成

本文定义当前阶段 `model` 模块和 adapter 如何消费 `polit/config`。其他业务模块尚未进入实现阶段，不在本文定义配置字段或热重载语义。

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
  -> model builds provider registry or request options
  -> model request binds snapshot version
```

## Model

`model` 模块消费：

```text
snapshot.config.model
```

职责：

- 校验 provider 协议。
- 构建 provider registry。
- 根据默认 provider/model 构建请求。
- 根据 model capabilities 决定 tool、streaming、thinking、JSON schema 等能力。
- 根据 multimodal constraints 校验 canonical content blocks。

热重载语义：

- 当前模型请求不切换。
- 后续模型请求使用新配置。
- API key、headers、timeout、URL 变化只影响新请求。
- model list 和 capabilities 变化需要重建 provider registry 版本。

`model` 可以暴露：

```text
modelRuntime.forSnapshot(snapshot)
```

或：

```text
modelRuntime.resolveModel(snapshot.config.model, requestOptions)
```

避免在请求中重新访问全局状态。

## Model Request 绑定

每次模型请求应记录：

```text
configSnapshotVersion
contentHash
providerId
modelId
providerRegistryVersion
```

这些信息用于排查“请求使用了哪一份配置”，但不能把 API key、headers 中的认证字段或完整配置写入日志。

## Provider Registry

`model` 模块可以把 `snapshot.config.model` 编译成 provider registry：

```text
ModelProviderRegistry
  version
  snapshotVersion
  providers
  defaultProvider
  defaultModel
  fallbackModel
```

registry 重建规则：

- snapshot 发布后，`model` 模块可以异步重建 registry。
- registry 必须绑定 snapshot version。
- 旧请求继续使用旧 registry。
- 新请求使用最新已成功构建的 registry。
- 如果新 registry 构建失败，保留旧 registry 并发布 `model.registry.reload.failed` 诊断。

## Model 二次校验

总 schema 只能校验配置结构。`model` 模块仍需做模型语义校验：

- protocol adapter 是否存在。
- provider URL 是否能被 adapter 接受。
- API key 是否已解析为可用 secret 或 secret handle。
- default model 是否可被当前 provider 使用。
- fallback model 是否和错误恢复策略兼容。
- capabilities 是否满足 request builder 需要。
- multimodal constraints 是否能约束 canonical content block。
- provider headers 是否包含不支持或冲突的字段。

## Adapters

CLI、TUI、SDK、Web、Remote adapter 都应通过 `polit/config` 注入覆盖项。

### CLI

CLI flag 示例：

```text
--model
--provider
--api-key-env
```

这些 flag 不应直接改 `model` 模块，也不作为新的 `PolitConfigSource.kind`。当前阶段如果 adapter 需要覆盖配置，应转换为受控 env override 或要求用户写入项目级配置。

### SDK

SDK options 示例：

```text
Agent.create({
  model
})
```

SDK 需要能拿到配置诊断，方便调用方在 headless 环境展示错误。

### UI/TUI

UI/TUI 可以订阅 config events，用于提示：

- 配置已重载。
- 配置重载失败。
- 某些变更需要重启。
- 默认模型、provider 或认证引用发生变化。

UI 不应保存配置事实来源。设置页保存后仍由 config loader 重新读取并发布 snapshot。

## Config Facade

建议给上层暴露一个小型 facade：

```text
PolitConfigRuntime
  getSnapshot()
  reload(reason)
  subscribe(listener)
  getDiagnostics()
```

不要暴露 loader 内部细节给业务模块。

## 生效范围矩阵

```text
配置项                         默认生效范围
model.defaultModel             next-request
model.fallbackModel            next-request
model.provider.url             next-request
model.provider.apiKey          next-request
model.provider.timeoutMs       next-request
model.provider.headers         next-request
model.provider.retry           next-request
model.provider.models          next-request
model.capabilities             next-request
model.multimodal               next-request
POLIT_HOME                     restart-required
```

具体实现可以从保守策略开始：`model` 业务变更只对后续模型请求生效。`POLIT_HOME` 由环境变量控制，不属于 YAML 配置，运行中变化需要重启。

## 未来业务模块

`context`、`tool`、`permission`、`session`、`extension` 等模块接入时，应新增独立文档或扩展本文。当前阶段不要在 `polit/config` 文档中提前定义这些模块的业务配置。

## 禁止模式

实现时应避免：

- 模块启动时读取一次配置后永远不更新。
- 每次模型请求都重新读 YAML。
- 在 `model` 模块内直接访问 process env。
- 让 CLI flag 绕过 config snapshot。
- 在日志中记录未脱敏配置。
- 在热重载时修改已发出的模型请求。

`polit/config` 的价值在于让运行时所有入口共享同一份配置事实来源。