# Model 测试方案

本文定义 `model` 模块的测试方法、测试用例和测试文件组织方式。

## 测试目录

测试文件统一维护在项目根目录下：

```text
/Users/gucc1/Codes/work/modelbest/PolitDeck/tests/
```

当前组织：

```text
tests/
  model/
    config/
      parse-model-config.test.ts
      resolve-credentials.test.ts

    protocols/
      anthropic-request.test.ts
      openai-request.test.ts
      response-and-stream.test.ts

    runtime/
      model-runtime.test.ts

    e2e/
      real-model-request.test.ts
      stream-real-model.ts

    helpers.ts
```

## 测试方法

### 配置测试

配置测试不访问真实网络，只验证全局 config 传入的 `model` 配置段、schema 校验和环境变量解析。

覆盖：

- 能从 `politdeck.yaml` fixture 中抽取并解析 `model` 配置段。
- 支持 `${ENV_NAME}` API key 引用。
- 环境变量缺失时报错。
- provider 缺失时报错。
- protocol 不支持时报错。
- url 非法时报错。
- default model 不属于 default provider 时报错。
- model list 为空时报错。
- model 级别 capabilities 合并逻辑正确。
- model 级别 multimodal input list 和限制项校验正确。

### 请求构造测试

请求构造测试使用固定 canonical request，断言转换后的厂商请求结构。

覆盖：

- Anthropic request 包含 system、messages、tools、model、max tokens。
- OpenAI request 包含 messages、tools/tool_calls 相关字段、model、max tokens。
- tool schema 转换正确。
- tool result 转换正确。
- thinking 配置只在选定 model 支持时启用。
- 多模态输入只在选定 model 的 `multimodal.input` 列表支持时写入请求体。
- 不支持的能力不会被错误写入请求。

### 响应解析测试

默认响应解析、流式解析和 provider 错误归一化测试使用固定 raw response、SSE chunk 或 fake transport，不访问真实网络。它们覆盖 provider adapter 的请求构造、响应读取、事件归一化和错误归一化，最后断言对 agent loop 暴露的 canonical event、canonical response 或 `CanonicalModelError`。

覆盖：

- text response。
- tool call response。
- usage 解析。
- finish reason 归一化。
- provider error 归一化。

### 流式解析测试

流式解析测试默认使用固定 SSE chunk 或 fake transport。断言覆盖从 `ModelRuntime.stream()` 到最终 canonical event 序列的链路，也保留 provider stream normalizer 的局部解析用例。

覆盖：

- Anthropic text delta。
- Anthropic tool_use delta。
- Anthropic thinking delta。
- OpenAI content delta。
- OpenAI tool_call delta。
- message start/end 事件顺序。
- usage 事件。
- stream error。

真实 API 测试集中在 `tests/model/e2e/`。`real-model-request.test.ts` 只有在 `POLITDECK_RUN_REAL_MODEL_E2E=1` 时运行，并从当前 PolitHome 配置读取 `url`、API key 和 model id，避免普通单元测试依赖外部网络和费用。

### Capabilities 测试

覆盖：

- adapter 默认 capabilities 正确。
- `politdeck.yaml` 中 model 级别 capabilities 可覆盖默认值。
- 同一 provider 下不同 model 可以有不同 capabilities。
- agent loop 只依赖选定 model 的 capabilities，不依赖 provider 名称。
- multimodal input list 和限制项会影响请求构造和不支持输入的拒绝逻辑。

## 核心用例

### 用例 1：加载 Anthropic 配置

输入：

```yaml
model:
  defaultProvider: anthropic-main
  defaultModel: claude-sonnet-4-5
  providers:
    anthropic-main:
      protocol: anthropic
      url: https://api.anthropic.com
      apiKey: ${ANTHROPIC_API_KEY}
      timeoutMs: 120000
      models:
        claude-sonnet-4-5:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsThinking: true
            maxContextTokens: 200000
            maxOutputTokens: 8192
          multimodal:
            input: [text, image]
            maxImagesPerRequest: 20
```

断言：

- provider id 为 `anthropic-main`。
- protocol 为 `anthropic`。
- API key 从环境变量读取。
- model id 为 `claude-sonnet-4-5`。
- capabilities 从 model 级别配置合并。
- multimodal input list 和限制项从 model 级别配置读取。

### 用例 2：加载 OpenAI 配置

断言：

- protocol 为 `openai`。
- request adapter 使用 OpenAI 协议转换。
- 选定 model 的 thinking 默认关闭。
- 选定 model 的 prompt cache 默认关闭。

### 用例 3：Anthropic tool_use 解析

断言：

- `ModelRuntime.stream()` 在 fake transport 或固定 stream chunk 下输出稳定 canonical event 序列。
- `tool_use` block 被解析为 `CanonicalToolCall`。
- tool call id、name、input 保持稳定。
- 原始响应保留在 raw 字段。

### 用例 4：OpenAI tool_call 解析

断言：

- `ModelRuntime.stream()` 在 fake transport 或固定 stream chunk 下输出稳定 canonical event 序列。
- OpenAI tool call delta 可以合并成完整 `CanonicalToolCall`。
- arguments JSON 解析失败时返回可分类错误。该错误分支可以使用 mock transport 或构造 parser 输入覆盖，因为真实 provider 不稳定地产生非法 JSON 不适合作为常规集成断言。

### 用例 5：不支持 thinking 的 model

输入 canonical request 中包含 thinking。

断言：

- 选定 model 的 capabilities 不支持 thinking 时，请求构造阶段禁用 thinking。
- 不抛出无意义的 provider API 错误。

### 用例 6：多模态请求构造

输入 canonical request 中包含 image content block。

断言：

- 选定 model 支持 image input 时，provider request 包含正确的多模态 content block。
- 选定 model 不支持 image input 时，请求构造阶段返回可分类错误。
- 不支持输入的拒绝逻辑使用 mock 或纯 request builder 测试即可，不依赖真实 provider API 返回。

### 用例 7：配置错误

覆盖：

- YAML 文件缺失。
- API key 环境变量缺失。
- protocol 写成未知值。
- url 不是 URL。
- defaultModel 不存在于 defaultProvider 的 model list。
- multimodal 类型错误。
- multimodal.input 不是字符串列表。
- multimodal.input 包含未知 modality。

断言统一返回 `ModelConfigError`。

### 用例 8：provider 错误归一化

输入 fake transport 或固定错误响应，覆盖至少一种稳定可触发错误，例如无效 API key、无效 model id、非 JSON 错误响应或超过上下文/输出限制。限流这类不稳定错误可保留 mock transport 测试。

断言：

- `ModelRuntime.stream()` 通过 `error` event 返回统一 `CanonicalModelError`，`ModelRuntime.complete()` 通过 `ModelProviderError` 携带统一错误。
- `status`、`code`、`retryable` 和 `raw` 保持稳定。
- agent loop 不需要读取 Anthropic/OpenAI SDK 的原始错误类型。

## 禁止事项

模型模块单元测试不应：

- 依赖真实 OAuth。
- 依赖真实用户主目录下的 `~/.politdeck` 配置。
- 读取 `~/.politdeck/politdeck.yaml` 之外的散落配置。
- 把 Anthropic/OpenAI SDK 类型暴露给 agent loop 测试。

除响应解析、流式解析和 provider 错误归一化之外，模型模块单元测试不应调用真实模型 API。真实网络集成测试作为单独测试套件维护，不应成为默认单元测试的一部分。