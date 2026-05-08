# Model 配置

本文定义当前 `model` 模块读取和校验的配置项。`PolitDeck` 的模型配置来自全局 YAML、项目级 YAML 和受控环境变量覆盖合并后的 `model` 配置段，不独立维护属于 `model` 模块的 YAML 文件。

## 总配置文件位置

全局 config 模块当前默认读取：

```text
~/.politdeck/politdeck.yaml
```

该路径由全局 `polit/config` 模块通过 `resolvePolitHome()` 和 `getPolitConfigFilePath()` 统一解析：`PolitHome` 默认是 `~/.politdeck`，可由 `POLIT_HOME` 覆盖；配置文件名固定为 `politdeck.yaml`。全局 config 模块还会按需读取项目根目录 `.politdeck.yaml`，并叠加 `POLIT_MODEL_DEFAULT_PROVIDER`、`POLIT_MODEL_DEFAULT_MODEL`、`POLIT_MODEL_FALLBACK_MODEL` 三个环境变量覆盖项。`model` 模块只校验和消费合并后的 `model` 段，不直接读取 YAML 文件、临时 CLI 参数、用户目录中的其他配置文件或运行时全局状态；API key 的 `${ENV_NAME}` 引用在解析模型配置时解析。

## 当前阶段范围

当前阶段只实现：

- 校验全局 config 模块传入的 `model` 配置段。
- 消费 provider 配置。
- 消费协议格式。
- 消费 URL。
- 解析 API key 引用。
- 消费默认模型。
- 消费可选 fallback model。
- 消费 headers、timeout、retry 等连接参数。
- 消费 provider 下的 model list。
- 消费 model 级别 capabilities。
- 消费 model 级别 multimodal constraints。

暂不实现：

- OAuth 登录。
- 浏览器登录。
- claude.ai 登录。
- token 自动刷新。
- 远端密钥同步。
- 多租户密钥托管。

但配置结构必须为这些能力保留扩展点。

## 配置示例

```yaml
model:
  defaultProvider: anthropic-main
  defaultModel: claude-sonnet-4-5
  fallbackModel: claude-haiku-4-5

  providers:
    anthropic-main:
      protocol: anthropic
      url: https://api.anthropic.com
      apiKey: ${ANTHROPIC_API_KEY}
      timeoutMs: 120000
      headers:
        anthropic-version: "2023-06-01"
      models:
        claude-sonnet-4-5:
          displayName: Claude Sonnet 4.5
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: true
            supportsThinking: true
            supportsJsonSchema: true
            supportsPromptCache: true
            maxContextTokens: 200000
            maxOutputTokens: 8192
          multimodal:
            input: [text, image, pdf]
            maxImagesPerRequest: 20
            maxImageBytes: 5242880
            supportedImageMimeTypes:
              - image/png
              - image/jpeg
              - image/webp
            maxPdfPages: 100
            imageDetail: auto

        claude-haiku-4-5:
          displayName: Claude Haiku 4.5
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: false
            supportsThinking: false
            supportsJsonSchema: true
            supportsPromptCache: true
            maxContextTokens: 200000
            maxOutputTokens: 4096
          multimodal:
            input: [text, image]
            maxImagesPerRequest: 10
            supportedImageMimeTypes:
              - image/png
              - image/jpeg

    openai-main:
      protocol: openai
      url: https://api.openai.com/v1
      apiKey: ${OPENAI_API_KEY}
      timeoutMs: 120000
      headers: {}
      models:
        gpt-5.1:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: true
            supportsThinking: false
            supportsJsonSchema: true
            supportsPromptCache: false
            maxContextTokens: 128000
            maxOutputTokens: 8192
          multimodal:
            input: [text, image, audio]
            maxImagesPerRequest: 20
            maxAudioSeconds: 600
            supportedImageMimeTypes:
              - image/png
              - image/jpeg
              - image/webp
```

## 配置项

### 顶层配置

```text
model.defaultProvider
model.defaultModel
model.fallbackModel
model.providers
```

- `model.defaultProvider`：默认使用的 provider id。
- `model.defaultModel`：默认使用的 model id，必须存在于默认 provider 的 `models` 中。
- `model.fallbackModel`：可选 fallback model id，当前校验为必须存在于任意 provider 的 `models` 中。
- `model.providers`：provider 配置 map。

### Provider 配置

```text
protocol
url
apiKey
timeoutMs
headers
retry
models
```

- `protocol`：协议类型，目前支持 `anthropic`、`openai`。
- `url`：provider 服务 URL。
- `apiKey`：API key，支持 `${ENV_NAME}` 形式引用环境变量。
- `timeoutMs`：请求超时时间。
- `headers`：附加请求头。
- `retry`：重试策略。
- `models`：该 provider 下可用模型列表。

Provider 配置只描述连接、认证、协议和请求默认参数。模型能力不放在 provider 上，因为同一个 provider 下的不同模型可能有不同上下文长度、工具调用、thinking、JSON schema、多模态输入输出和流式能力。

### Model 配置

```text
displayName
capabilities
multimodal
aliases
request
```

- `displayName`：用户可见模型名称。
- `capabilities`：该具体模型的能力声明。
- `multimodal`：该具体模型的多模态输入能力和结构化限制。
- `aliases`：可选别名。
- `request`：可选模型级请求参数覆盖，例如 temperature 默认值、reasoning 参数名或厂商特定开关。

## API Key 解析

当前阶段支持：

```text
apiKey: ${ANTHROPIC_API_KEY}
apiKey: sk-...
```

解析规则：

- 如果值形如 `${NAME}`，从进程环境变量读取。
- 如果是普通字符串，按明文 key 使用。
- 如果缺失或环境变量不存在，配置加载失败。

未来可以扩展：

```yaml
auth:
  type: oauth
  clientId: ...
  tokenStore: ...
```

但当前阶段不实现。

## Model Capabilities 配置

当前支持：

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

capabilities 属于 model 级别配置。adapter 可以提供协议默认值，但最终有效能力必须由具体 model 决定，agent loop 和请求构造逻辑只读取选定 model 的 capabilities。

capabilities 只表达通用模型能力，不表达具体输入模态。不要在 capabilities 中重复声明 `supportsImage`、`supportsPdf`、`supportsAudio` 等字段；这些属于 `multimodal.input`。

## 多模态配置

多模态能力也属于 model 级别配置，因为它会影响 context 是否允许将某类 canonical content block 交给 `model`，也会影响 provider adapter 的请求体转换逻辑。

当前支持：

```text
multimodal.input
multimodal.maxImagesPerRequest
multimodal.maxImageBytes
multimodal.supportedImageMimeTypes
multimodal.maxPdfPages
multimodal.maxPdfBytes
multimodal.maxAudioSeconds
multimodal.imageDetail
```

`multimodal.input` 是字符串列表，例如 `[text]`、`[text, image]`、`[text, image, pdf]` 或 `[text, image, audio]`。列表中出现某个 modality 表示该 model 支持这种输入；不出现则表示不支持。当前阶段只建模输入模态，不建模输出模态。若未来产品支持图片、音频或视频生成，应在 canonical response/event 中新增输出 content block，再扩展配置，而不是提前把输出能力塞进当前输入校验模型。

如果某个 model 不支持某类输入，context 应在构造 `CanonicalModelRequest` 前处理或拒绝。`model` 的 request builder 还应在 API 边界做一次防御性校验，避免把不支持的 content block 交给 provider 后再依赖 API 报错。

## 配置加载流程

```text
load ~/.politdeck/politdeck.yaml in global config
  -> optionally load <project>/.politdeck.yaml
  -> apply supported env overrides
  -> merge sources
  -> extract model section
  -> parseModelConfig(model)
  -> resolve env placeholders
  -> validate provider protocol
  -> validate provider models
  -> merge adapter protocol defaults
  -> apply model-level capabilities and multimodal constraints
  -> return ModelConfig
```

## 配置错误

必须区分：

- 总配置文件不存在（由全局 config 模块报告）。
- YAML 语法错误（由全局 config 模块报告）。
- provider 缺失。
- protocol 不支持。
- url 非法。
- apiKey 缺失。
- defaultModel 缺失。
- defaultModel 不属于 defaultProvider。
- fallbackModel 不存在于任何 provider 的 model list。
- provider.models 为空。
- capabilities 类型错误。
- multimodal 类型或取值错误。
- multimodal.input 不是字符串列表。
- multimodal.input 包含不支持的 modality。

错误应进入统一 `ModelConfigError`，供 CLI/SDK 以稳定格式展示。