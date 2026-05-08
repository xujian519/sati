# Model 模块架构

`model` 模块是 agent loop 与外部模型服务之间的协议适配层。它不负责工具执行、权限判断、上下文压缩或 session 持久化，只负责模型请求、响应、流式事件、错误和 usage 的统一转换。

## 职责

`model` 模块负责：

- 校验和消费全局 config 模块传入的 `model` 配置段。
- 根据配置选择 provider。
- 将内部 `CanonicalModelRequest` 转换为厂商请求。
- 支持 Anthropic 和 OpenAI 两类协议格式。
- 解析非流式和流式响应。
- 将厂商事件归一化为 `CanonicalModelEvent`。
- 归一化错误、usage、finish reason、tool call、thinking/text delta 等信息。
- 暴露 model capabilities 和 multimodal constraints，供 agent loop、context 和 request builder 判断工具调用、thinking、JSON schema 与多模态输入支持。

## 非职责

`model` 模块不负责：

- OAuth 登录流程。
- 用户交互式认证。
- 工具执行。
- 权限判断。
- prompt 组装。
- context compact。
- 输入附件解析。
- context attachment 注入。
- 多模态附件读取、MIME 探测、压缩、token 估算或预算裁剪。
- transcript 写入。
- UI 输出。

这些能力应分别归属于 `permission`、`tool`、`context`、`session`、`adapters` 等模块。

## 当前目录结构

当前 `src/model` 目录结构为：

```text
src/model/
  ModelRuntime.ts
  index.ts

  config/
    parseModelConfig.ts
    schema.ts
    resolveCredentials.ts

  protocol/
    canonical.ts
    capabilities.ts
    multimodal.ts
    errors.ts

  providers/
    registry.ts
    anthropic/
      request.ts
      response.ts
      stream.ts
      defaults.ts
    openai/
      request.ts
      response.ts
      stream.ts
      defaults.ts

  request/
    buildModelRequest.ts
    validateModelRequest.ts

  response/
    parseModelResponse.ts
    normalizeUsage.ts
    normalizeFinishReason.ts

  streaming/
    assembleModelMessage.ts
    streamModel.ts
    normalizeStreamEvent.ts

  errors/
    normalizeModelError.ts
```

该结构已经落到源码中。模型模块的核心不是“client 类”，而是配置解析、请求校验、协议转换、响应/流事件归一化和能力声明。`ModelRuntime` 是面向上层的运行时入口；`streamModel()` 和 `complete()` 负责实际发送 provider 请求。

## 核心接口

当前对外暴露少量稳定接口：

```text
parseModelConfig(rawModelConfig, { env }) -> ModelConfig
createModelRuntime(config, options) -> ModelRuntime
ModelRuntime.stream(request) -> AsyncIterable<CanonicalModelEvent>
ModelRuntime.complete(request) -> Promise<CanonicalModelResponse>
ModelRuntime.getCapabilities(providerId, modelId) -> ModelCapabilities
buildModelRequest(request, config) -> ProviderRequestBody
validateModelRequest(request, config) -> ResolvedModelRequest
ModelProviderRegistry.get(protocol) -> ModelProviderAdapter
```

全局 `polit/config` 模块负责读取 `${PolitHome}/politdeck.yaml`、项目级 `.politdeck.yaml` 和受控环境变量覆盖。`model` 模块接收合并后的 `model` 段，校验模型配置结构、解析 API key 环境变量引用并产出 `ModelConfig`。上层模块依赖 `createModelRuntime(config)` 返回的 `stream()`、`complete()` 和选定 model 的 capabilities / multimodal constraints，不直接依赖 Anthropic/OpenAI 的 SDK 类型。

## Canonical Protocol

内部统一协议至少包括：

```text
CanonicalModelRequest
CanonicalMessage
CanonicalContentBlock
CanonicalToolSchema
CanonicalToolCall
CanonicalToolResult
CanonicalModelEvent
CanonicalModelResponse
CanonicalUsage
CanonicalModelError
```

所有 provider adapter 都负责在 canonical protocol 和厂商协议之间转换。

## Model Capabilities

每个具体 model 的最终有效能力来自“协议默认值 + model 级 overrides”。配置里可以只声明需要覆盖的字段，`parseModelConfig()` 会补齐完整能力对象：

```text
supportsToolUse
supportsStreaming
supportsParallelToolCalls
supportsThinking
supportsJsonSchema
supportsSystemPrompt
supportsPromptCache
maxContextTokens
maxOutputTokens
```

capabilities 表达通用模型能力，不包含具体多模态类型。多模态支持由 `multimodal` 结构单独表达，例如 `input: ["text", "image", "pdf"]` 和对应限制项。

同一个 provider 下的不同 model 可以有不同 capabilities 和 multimodal constraints。agent loop 根据选定 model 的 capabilities 决定请求构造策略，context 根据 multimodal constraints 判断已经归一化的 `CanonicalContentBlock` 是否可发送，而不是在 loop 中硬编码某个厂商或 provider 的特殊逻辑。

## 与 Agent Loop 的边界

`agent` 向 `model` 提交已经准备好的请求：

```text
AgentLoop
  -> build CanonicalModelRequest
  -> ModelRuntime.stream(canonicalRequest)
  -> consume CanonicalModelEvent
  -> Tool.detectToolCalls()
```

上层 context/input 代码负责把用户输入、文件、IDE selection、memory、MCP resources 和其他 context attachments 解析/投影为 `CanonicalMessage.content`。`model` 不接收独立 `attachments` 字段，只处理已经进入 canonical messages 的内容块。

`model` 返回统一事件：

```text
request_started
message_start
text_delta
thinking_delta
tool_call_start
tool_call_delta
tool_call_end
message_end
usage
error
```

`model` 不直接执行工具。工具调用只以事件或 assistant message 的形式返回给 `agent`，由 `tool` 和 `permission` 继续处理。