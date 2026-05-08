# Provider 协议适配

本文定义 `model` 模块对 Anthropic 和 OpenAI 两类协议的请求构造、响应解析和流式事件归一化要求。

## 支持范围

当前阶段支持两类协议格式：

- `anthropic`：Anthropic Messages API 风格协议。
- `openai`：OpenAI Chat Completions 兼容风格协议。

这里的协议类型不等于厂商名称。未来其他厂商如果兼容 OpenAI Chat Completions 协议，可以通过 `protocol: openai` 接入；如果提供独立协议，则新增 provider adapter。当前实现尚未接入 OpenAI Responses API。

## Canonical Request

agent loop 内部只生成统一请求：

```text
CanonicalModelRequest:
  model
  provider
  messages
  systemPrompt
  tools
  toolChoice
  maxOutputTokens
  temperature
  thinking
  stream
  metadata
```

Provider adapter 负责转换字段。输入附件、IDE 上下文、memory、MCP resource 等内容必须在进入 `model` 前由 input/context 模块解析为 `messages[].content` 中的 canonical content block；`CanonicalModelRequest` 不提供独立 `attachments` 字段。

## Anthropic 协议

Anthropic adapter 负责把 canonical request 转换为 Anthropic Messages API 语义。

转换重点：

- `systemPrompt` 转为 Anthropic system 字段。
- `messages` 转为 Anthropic message list。
- `tools` 转为 Anthropic tool schema。
- `tool_result` 和 `tool_use` 保持 Anthropic content block 语义。
- `thinking` 只在选定 model 的 capabilities 支持时启用。
- 多模态 content block 只在选定 model 的 `multimodal.input` 列表支持时写入请求。
- `maxOutputTokens` 转为对应输出 token 限制。
- 流式响应解析为统一事件。

Anthropic 响应中需要解析：

- text delta。
- thinking delta。
- tool_use block。
- message stop。
- usage。
- stop reason。
- API error。

## OpenAI 协议

OpenAI adapter 负责把 canonical request 转换为 OpenAI Chat Completions 语义，请求发送到 provider URL 下的 `chat/completions`。

转换重点：

- `systemPrompt` 转为 system message。
- `messages` 转为 OpenAI message list。
- `tools` 转为 OpenAI function/tool schema。
- `tool_use` 转为 tool call。
- `tool_result` 转为 tool role message。
- `maxOutputTokens` 转为 `max_tokens`。
- `thinking` 默认不启用，除非具体 model capabilities 声明支持。
- 图片、音频等多模态内容必须按选定 model 的 `multimodal.input` 列表和限制项转换。
- 流式响应解析为统一事件。

OpenAI 响应中需要解析：

- content delta。
- tool call delta。
- finish reason。
- usage。
- API error。

## 统一事件

两个 adapter 都必须输出同一组事件：

```text
CanonicalModelEvent:
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

如果某个 model 不支持某类事件或内容形态，应通过 capabilities 或 multimodal constraints 禁用相关能力，而不是输出伪造事件或构造 provider 不支持的请求体。

## Tool Call 归一化

内部统一 tool call 结构：

```text
CanonicalToolCall:
  id
  name
  input
  raw
```

Anthropic 的 `tool_use` 和 OpenAI 的 `tool_calls` 都必须转换为该结构。

## 错误归一化

Provider adapter 必须把错误转换为：

```text
CanonicalModelError:
  provider
  protocol
  code
  status
  message
  retryable
  raw
```

agent loop 只根据 `retryable`、`code`、`status` 和错误类型判断是否 fallback、重试或终止 turn。

## Usage 归一化

统一 usage 结构：

```text
CanonicalUsage:
  inputTokens
  outputTokens
  cacheReadTokens
  cacheWriteTokens
  totalTokens
```

不支持 cache token 的 provider 填 0 或 undefined，但字段语义必须稳定。

## 能力差异处理

不同 model 的能力差异由 capabilities 和 multimodal constraints 表达：

- Anthropic 可支持 thinking、tool use、prompt cache 等能力。
- OpenAI-compatible provider 可能支持 tool calls，但不一定支持 thinking 或 prompt cache。
- 本地模型可能只支持纯文本。
- 同一 provider 下的模型可能在上下文长度、并行工具调用、图片输入、音频输入和 PDF 输入上不同。

agent loop 不直接判断 provider 名称，只读取选定 model 的 capabilities 和 multimodal constraints。