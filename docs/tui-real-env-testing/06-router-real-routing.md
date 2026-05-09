# TUI Router 真实路由测试

本文验证从 TUI 发起的 turn 会真实经过 `RouterRuntime`，并按 `router.scenarios`、`router.fallback`、`router.tokenSaver` 等配置选择模型。TUI 本身不直接展示 router decision，因此本组用例必须同时记录 TUI 现象和 provider 侧可观察输出，例如 provider 控制台、代理日志、账单明细或本地兼容网关日志。

## 用例 1：默认场景路由

### 输入

准备两个真实可用模型，其中 `agent.model` 与 `router.scenarios.default` 指向同一个默认模型：

```yaml
agent:
  model: edgeclaw/moonshotai/kimi-k2.6

router:
  scenarios:
    default: edgeclaw/moonshotai/kimi-k2.6
    longContextThreshold: 60000

model:
  providers:
    edgeclaw:
      protocol: openai
      url: https://openrouter.ai/api/v1
      apiKey: ${OPENROUTER_API_KEY}
      timeoutMs: 120000
      models:
        moonshotai/kimi-k2.6:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: false
            supportsThinking: false
            supportsJsonSchema: true
            supportsSystemPrompt: true
            supportsPromptCache: false
            maxContextTokens: 128000
            maxOutputTokens: 8192
          multimodal:
            input: [text]
```

执行：

```bash
npm run build
node dist/src/cli/politdeck.js tui
```

在 TUI 中输入：

```text
请只回答 DEFAULT-ROUTE-OK。
```

### 预期现象

- TUI transcript 出现 `You` 和输入文本。
- 运行中出现 `thinking`。
- 完成后出现 `PolitDeck` 回复，且 `thinking` 消失。
- provider 日志中出现一次发往 `moonshotai/kimi-k2.6` 的请求。

### 预期输出

最终回复应包含：

```text
DEFAULT-ROUTE-OK
```

provider 侧记录的请求模型必须是 `moonshotai/kimi-k2.6`。如果 TUI 回复成功但 provider 侧模型不是 default 配置，该用例失败。

## 用例 2：长上下文场景路由

### 输入

把 `longContextThreshold` 临时设为很低，并配置一个与 default 不同的真实可用模型：

```yaml
router:
  scenarios:
    default: edgeclaw/moonshotai/kimi-k2.6
    longContext: edgeclaw/openai/gpt-4o-mini
    longContextThreshold: 1
```

确保 `model.providers.edgeclaw.models` 中同时登记 `moonshotai/kimi-k2.6` 和 `openai/gpt-4o-mini`。启动 TUI 后输入：

```text
这是一个用于触发 longContext router 场景的普通问题。请只回答 LONG-CONTEXT-ROUTE-OK。
```

### 预期现象

- TUI 仍表现为一次普通 turn：`You`、`thinking`、`PolitDeck`。
- provider 侧日志显示主请求模型为 `openai/gpt-4o-mini`。
- default 模型 `moonshotai/kimi-k2.6` 不应处理这次主请求。

### 预期输出

最终回复应包含：

```text
LONG-CONTEXT-ROUTE-OK
```

通过标准是 TUI 成功完成且 provider 侧主请求命中 `router.scenarios.longContext`。

## 用例 3：Fallback 路由

### 输入

配置一个会稳定失败的 primary provider，再配置一个真实可用 fallback provider。示例中 primary 使用不可达 URL，fallback 使用真实 provider：

```yaml
agent:
  model: broken/default-model

router:
  scenarios:
    default: broken/default-model
    longContextThreshold: 60000
  fallback:
    default:
      - edgeclaw/moonshotai/kimi-k2.6

model:
  providers:
    broken:
      protocol: openai
      url: https://127.0.0.1:9/v1
      apiKey: broken
      timeoutMs: 1000
      models:
        default-model:
          capabilities:
            supportsToolUse: false
            supportsStreaming: true
            supportsParallelToolCalls: false
            supportsThinking: false
            supportsJsonSchema: false
            supportsSystemPrompt: true
            supportsPromptCache: false
            maxContextTokens: 1000
            maxOutputTokens: 256
          multimodal:
            input: [text]
    edgeclaw:
      protocol: openai
      url: https://openrouter.ai/api/v1
      apiKey: ${OPENROUTER_API_KEY}
      timeoutMs: 120000
      models:
        moonshotai/kimi-k2.6:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: false
            supportsThinking: false
            supportsJsonSchema: true
            supportsSystemPrompt: true
            supportsPromptCache: false
            maxContextTokens: 128000
            maxOutputTokens: 8192
          multimodal:
            input: [text]
```

启动 TUI 后输入：

```text
请只回答 FALLBACK-ROUTE-OK。
```

### 预期现象

- TUI 会比普通请求多等待一次 primary 失败时间。
- 最终不应显示 primary 错误作为最终结果。
- provider 侧日志只会看到 fallback provider 的成功请求；primary 侧如果是本地不可达 URL，则只在本地错误日志中体现连接失败。
- turn 完成后 `thinking` 消失。

### 预期输出

最终回复应包含：

```text
FALLBACK-ROUTE-OK
```

如果最终 transcript 只显示连接失败、没有 fallback 成功回复，则该用例失败。

## 用例 4：Token Saver Judge 与 Tier 路由

### 输入

配置 `router.tokenSaver`，让 judge 和 SIMPLE tier 使用可观察的真实模型。为便于验收，建议 judge 和 tier 使用不同模型，并在 provider 日志中分别确认两次请求。

```yaml
router:
  scenarios:
    default: edgeclaw/moonshotai/kimi-k2.6
    longContextThreshold: 60000
  tokenSaver:
    enabled: true
    judge: edgeclaw/moonshotai/kimi-k2.6
    defaultTier: SIMPLE
    judgeTimeoutMs: 10000
    tiers:
      SIMPLE:
        model: edgeclaw/openai/gpt-4o-mini
        description: simple deterministic tasks
      COMPLEX:
        model: edgeclaw/moonshotai/kimi-k2.6
        description: complex reasoning tasks
```

启动 TUI 后输入：

```text
请只回答 TOKEN-SAVER-SIMPLE-OK。
```

### 预期现象

- TUI 完成一次普通 turn。
- provider 日志中先出现 judge 请求，再出现主回答请求。
- 主回答请求应命中 `SIMPLE` tier 的模型 `openai/gpt-4o-mini`。

### 预期输出

最终回复应包含：

```text
TOKEN-SAVER-SIMPLE-OK
```

如果 provider 日志中没有 judge 请求，或者主回答没有命中 SIMPLE tier 模型，则该用例失败。

## 用例 5：Router 配置错误不伪成功

### 输入

配置一个不存在的 router model ref：

```yaml
router:
  scenarios:
    default: edgeclaw/not-a-real-configured-model
```

启动 TUI 并输入：

```text
hello
```

### 预期现象

- local gateway 创建失败时 TUI 使用 fallback gateway。
- 提交消息后 transcript 显示配置或 gateway 错误。
- 不显示虚假的 `PolitDeck` 成功回复。

### 预期输出

预期错误包含 router/model ref 相关信息，例如：

```text
ROUTER_REF_MODEL_NOT_FOUND
```

或：

```text
No PolitDeck server is available and local config could not start session ...
```
