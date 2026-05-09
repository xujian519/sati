# Router 模块产品规格

本文对照旧项目 `third-party/claude-code-main` 中的 CCR（Claude Code Router）子系统，定义 PolitDeck 中 `router` 模块应提供的产品能力、运行对象、配置形态和事件规范。它是 router 子系统的 PRD / 功能文档，不是旧源码导览，也不是 MVP 计划。

## 1. 产品定位

`router` 是 PolitDeck Agent Runtime 中的请求路由与协议适配层。在用户通过 agent loop 提交一次模型请求时，`router` 负责：

- 决定该请求实际发往哪个 provider 与哪个 model（多 provider 路由）。
- 对请求做必要的协议转换、字段裁剪和能力适配（transformer 链）。
- 根据 token 数量、思考标签、子代理、长上下文等线索切换路由场景（scenarioType）。
- 根据 LLM judge 或外部分类策略，把任务分流到不同价格/能力档位（Token Saver）。
- 在编排（Auto-Orchestrate）模式下注入系统提示、收紧工具集、瘦身系统消息。
- 在 provider 失败时按场景执行 fallback。
- 收集 token 使用量、价格估算和会话级别统计（Token Stats）。
- 在 agent 切换会话或 sub-agent 嵌套时维护 sticky 路由状态（Session State）。

`router` 不直接执行工具、不持久化 transcript、不渲染 UI、不做权限决策；它是 `agent` -> `model` 之间的“控制平面”。

## 2. 旧项目能力清单

旧项目中 router 的能力沉淀在 `src/router/` 目录，主要包括：

- 入口：`router.ts`、`proxy.ts` 把 `~/.edgeclaw/config.yaml` 中的 router 段桥接到 CCR runtime（`src/router/server.cjs`）。
- 核心服务：`src/router/src/services/`
  - `config.ts`：基于 JSON5 / .env / process.env / `initialConfig` 的多源配置服务。
  - `provider.ts`：Provider 注册与 `provider,model` 路由解析。
  - `transformer.ts`：transformer 注册中心（默认内置 + 配置加载）。
  - `tokenizer.ts`：tokenizer 注册中心，支持 tiktoken / huggingface / api 三种实现。
- 路由内核：`src/router/src/utils/`
  - `router.ts`：preHandler hook 主入口（`router(req, _, ctx)`）。
  - `token-saver.ts`：LLM judge 分类、子代理识别、tier 解析。
  - `session-state.ts`：会话级 sticky tier/model + orchestrator flag（LRU + TTL 1h）。
  - `cache.ts`：基于 sessionId 的 last-usage 缓存。
- 服务封装：`src/router/src/server.ts` 用 Fastify 把 router preHandler、API 路由、token stats 装配为 HTTP server。
- 内部 pipeline：`src/router/src/pipeline.ts` 提供 in-process 处理（`processRequest()` + `installFetchInterceptor()`），可绕过 HTTP loopback。
- 22 个 transformer：`src/router/src/transformer/*.transformer.ts`，覆盖 OpenRouter、Gemini、Vertex、Cerebras、Groq、DeepSeek、Vercel、Reasoning、ToolUse、SamplingControl 等。
- 插件：`src/router/src/plugins/`
  - `token-stats.ts`：token usage 收集与 hourly/session 聚合。
  - `token-speed.ts`：响应吞吐与首 token 延迟统计。
  - `output/`：webhook、temp file、console 等输出 sink。
- Preset 体系：`src/router/shared/preset/`
  - `schema.ts`、`types.ts`：preset 文件结构。
  - `marketplace.ts`：远程 registry。
  - `install.ts` / `merge.ts` / `export.ts`：本地 preset 安装、与 `~/.claude-code-router/config.json` 合并、导出。
  - `sensitiveFields.ts`：敏感字段识别（用于 export 时清洗）。

## 3. 用户视角的产品能力

`router` 在用户层面的可观察行为可以归纳为下面几个能力面。

### 3.1 多 provider 路由

用户可以在配置中声明一个或多个上游 provider：

```text
Providers:
  - name: openrouter
    api_base_url: https://openrouter.ai/api/v1/chat/completions
    api_key: ${OPENROUTER_API_KEY}
    models: [anthropic/claude-sonnet-4.5, openai/gpt-5]
    transformer: { use: [openrouter] }
  - name: deepseek
    api_base_url: https://api.deepseek.com
    api_key: ${DEEPSEEK_API_KEY}
    models: [deepseek-chat, deepseek-reasoner]
    transformer: { use: [deepseek] }
```

用户在 agent 请求里使用 `provider,model` 字符串显式选定，例如 `openrouter,anthropic/claude-sonnet-4.5`。如果 `Router.default` 已配置，则 agent 可以省略 provider 部分，由 router 根据场景选择。

### 3.2 场景化路由

router 维护一组“场景类型”，每个场景关联一个目标 model：

```text
Router:
  default:        openrouter,anthropic/claude-sonnet-4.5
  background:     deepseek,deepseek-chat
  think:          openrouter,anthropic/claude-sonnet-4.5
  longContext:    openrouter,google/gemini-2.5-pro
  longContextThreshold: 60000
  webSearch:      openrouter,perplexity/sonar
```

场景识别规则（按优先级）：

1. 显式 `provider,model` 选定（且未启用 Token Saver）：直接使用该路由，scenarioType=`default`。
2. Token Saver 启用：进入 LLM judge 分流（见 §3.4）。
3. 长上下文：`tokenCount > longContextThreshold` 或 `lastUsage.input_tokens > longContextThreshold && tokenCount > 20000`，scenarioType=`longContext`。
4. CCR-SUBAGENT-MODEL 标签：`system[1].text` 以 `<CCR-SUBAGENT-MODEL>...</CCR-SUBAGENT-MODEL>` 包裹时使用包裹内 model，scenarioType=`default`。
5. 后台 Haiku：请求 model 同时包含 `claude` 与 `haiku` 时切到 `Router.background`，scenarioType=`background`。
6. Web search：`tools` 中存在 `type=web_search*` 工具时使用 `Router.webSearch`，scenarioType=`webSearch`。
7. Thinking：`req.body.thinking` 存在且 `Router.think` 已配置时使用 `Router.think`，scenarioType=`think`。
8. 其余情况使用 `Router.default`，scenarioType=`default`。

### 3.3 项目/会话级配置覆盖

router 在每次请求开始时按顺序查找：

1. `${HOME_DIR}/${project}/${sessionId}.json` 中的 `Router`。
2. `${HOME_DIR}/${project}/config.json` 中的 `Router`。
3. 全局配置中的 `Router`。

`project` 由 `searchProjectBySession()` 在 `~/.claude/projects/` 下扫描包含 `${sessionId}.jsonl` 的子目录确定，结果以 LRU（max 1000）缓存。

### 3.4 Token Saver（LLM judge 分流）

Token Saver 启用后由 `classifyAndRoute()` 调用一个轻量 judge 模型把用户最新一条消息分到固定 tier，每个 tier 对应一个 model：

```text
Router:
  tokenSaver:
    enabled: true
    judgeProvider: deepseek
    judgeModel: deepseek-chat
    defaultTier: SIMPLE
    tiers:
      SIMPLE:    { model: deepseek,deepseek-chat }
      MEDIUM:    { model: openrouter,anthropic/claude-sonnet-4.5 }
      COMPLEX:   { model: openrouter,anthropic/claude-opus-4 }
      REASONING: { model: openrouter,openai/gpt-5 }
    rules:
      - "If task involves multi-file refactor or architectural design, use COMPLEX."
      - "If task asks for reasoning over long math/logic chains, use REASONING."
    subagentPolicy: judge
    subagentModel: deepseek,deepseek-chat
```

子代理路由策略：

- `skip`：子代理强制用 `Router.default`，不分流。
- `judge`：子代理也跑 judge，但用 `${sessionId}:sub` 作为 sticky key。
- `inherit`：子代理继承主 session 的 sticky tier。
- `fixed`：子代理强制使用 `subagentModel`。

子代理识别规则（任一命中即视为 sub-agent）：

- system 数组第二个 block 以 `<CCR-SUBAGENT-MODEL>` 开头。
- 工具列表非空但不存在名为 `Agent` 的工具（Claude Code 主代理特征）。

每条会话的 sticky 状态保存在 `session-state.ts`（LRU 500，TTL 3600s）：相同 session 后续请求复用上一次 judge 的 tier，避免重复调用 judge。

### 3.5 Auto-Orchestrate（编排模式）

当 `autoOrchestrate.enabled=true` 且 router 把请求分类到 `triggerTiers`（默认 `["COMPLEX", "REASONING"]`）时：

- 主代理：
  - 可选覆盖 `mainAgentModel`。
  - 在 `messages` 头部插入一条 `role=user`、内容为 `<system-reminder><auto-orchestrate tier=...>...orchestratorPrompt...</auto-orchestrate></system-reminder>` 的引导消息。
  - 按 `blockedTools`（默认 `mcp__browser-use__`、`WebSearch`、`WebFetch` 前缀）裁剪工具集，强制走 `Agent()` 委派。
  - 默认开启 `slimSystemPrompt`：把 `system` 数组瘦身成 1 个 orchestrator 引导 block，并保留含 ClawXMemory / memory_* 关键字的 block。
- 子代理：
  - 不再覆盖 model，由 Token Saver 决定（COMPLEX/REASONING 选高档，SIMPLE/MEDIUM 选低档）。
  - 不再注入 orchestrator prompt 或裁剪工具。
- 非 Claude orchestrator（GPT-5 等）：
  - 重写 `tool_result` 中的 `Async agent launched` 文本，强制要求继续调用工具，避免对话断流。

会话进入 orchestrating 状态后，后续同一 session 即使分类不再触发 `triggerTiers` 也保持 orchestrating。

### 3.6 Transformer 链

每个 provider 可以挂载若干 transformer，按 request → response 顺序执行：

```text
provider.transformer:
  use: [openrouter]
  "anthropic/claude-sonnet-4.5":
    use: [tooluse, reasoning]
```

执行顺序：

```text
transformer.transformRequestOut(body)
  -> provider.transformer.use[*].transformRequestIn(...)
  -> provider.transformer[model].use[*].transformRequestIn(...)
  -> sendUnifiedRequest(...)
  -> reverse(provider.transformer[model].use[*].transformResponseOut(...))
  -> reverse(provider.transformer.use[*].transformResponseOut(...))
  -> transformer.transformResponseIn(...)
```

`bypass` 模式（provider transformer 仅含与端点同名 transformer，且 model 级 transformer 不再额外指定）下跳过 `transformRequestOut` / `transformResponseIn`，直接转发请求体。

旧项目内置 22 个 transformer，需要在 PolitDeck 第一版至少明确每个 transformer 的“是否保留 / 是否第一版直接迁移 / 是否暂缓”。

### 3.7 Token Stats / Token Speed / Token Cache

- `TokenStatsCollector`：采样每次 `/v1/messages` 完成的 input/output/cacheRead token，按 session、hour、global 聚合，写入磁盘并支持热更 modelPricing。
- `tokenSpeedPlugin`：测量首 token 延迟、tokens/s 与流式吞吐。
- `sessionUsageCache`（utils/cache）：保存 sessionId -> 上一次 usage，给“长上下文”判定提供 lastUsage。

### 3.8 Preset 体系

旧项目支持 preset 安装与 marketplace：

- `marketplace.ts`：远程 registry，支持 list / search / fetch。
- `install.ts` + `merge.ts`：把 preset 中的 `Providers` / `Router` / `transformers` / `StatusLine` 合并进 `~/.claude-code-router/config.json`。
- `export.ts` + `sensitiveFields.ts`：导出配置时清洗 API key / Secret。
- `schema.ts` + `types.ts`：preset 输入 schema、template 替换、ConfigMapping。
- `readPreset.ts`：从 ZIP / 目录 / URL 加载 manifest。

PolitDeck 第一版可以视该子系统为后续阶段产品能力，不强制迁移；但产品规格仍把它列为长期目标。

### 3.9 Fallback

按 scenarioType 配置 fallback 列表：

```text
fallback:
  default:     [deepseek,deepseek-chat]
  background:  [deepseek,deepseek-chat]
  longContext: [openrouter,google/gemini-2.5-pro, deepseek,deepseek-chat]
```

主请求返回非 2xx 或 zero-usage 重试用尽时，按列表顺序尝试下一个候选 model（重新跑 transformer 链）。

### 3.10 Zero-Usage Retry

主请求返回 200 但 `usage.prompt_tokens === 0 && usage.completion_tokens === 0 && hasContent`（流式或非流式）时，最多重试 5 次。流式响应需要先把已读 chunk 全部缓冲再 replay。

### 3.11 HTTP API

CCR runtime 以 Fastify HTTP server 形态对外服务，至少包括：

- `POST /v1/messages`：Anthropic Messages 兼容入口，触发 router preHandler。
- `GET /health`：存活探针。
- `GET /api/stats/summary`、`/api/stats/sessions`、`/api/stats/hourly`：token 统计。
- `POST /api/stats/reset`：清空统计。
- `GET /`：版本/标识。

支持 namespace 注册（`registerNamespace(name, options)`），方便同进程下挂载多个 provider 集合。

### 3.12 In-process Pipeline

`pipeline.ts` 把 router 主流程从 Fastify 中抽离成 `processRequest(url, init, services, realFetch)`，并通过 `installFetchInterceptor(sentinelBaseUrl, services)` 替换 `globalThis.fetch`。Anthropic SDK 调用时，符合 sentinel 前缀的 URL 直接走 in-process pipeline，免去 HTTP 回环。

## 4. 核心运行对象

### RouterRequest

router 收到的请求至少包含：

```text
RouterRequest:
  body:
    model              # "provider,model" 字符串
    messages
    system?
    tools?
    thinking?
    metadata?          # 含 user_id / session_id 的 JSON 串或 user_XXX_session_YYY
    stream?
  headers
  log
  url
  sessionId?           # 解析后写回
  scenarioType?        # router 决策后写回
  tokenSaverTier?      # tokenSaver 命中时写回
  isSubagent?          # subagent 检测命中时写回
  tokenCount?          # tokenizer 计算后写回（供 customRouter 使用）
```

### RouterDecision

router 调用一次后产出的可观察决策：

```text
RouterDecision:
  provider: string
  model: string                  # 不含 provider 前缀
  scenarioType: 'default' | 'background' | 'think' | 'longContext' | 'webSearch' | 'tokenSaver'
  tokenSaverTier?: string
  isSubagent: boolean
  orchestrating: boolean
  resolvedFrom: 'explicit' | 'scenario' | 'tokenSaver' | 'custom' | 'fallback'
  mutations: RouterMutationsLog
```

### RoutingPipelineExecution

router 完整执行 pipeline 后给 stats / 日志 / UI 的事件：

```text
PipelineExecution:
  sessionId, provider, model, scenarioType, tokenSaverTier, isSubagent
  request:  CanonicalModelRequest
  response: usage, finishReason, cacheRead
  timing:   firstTokenMs, totalMs, tokensPerSec
  fallbackChain: [{ provider, model, status }, ...]
```

### SessionRoutingState

```text
SessionRoutingState:
  sessionId
  stickyTier
  stickyModel
  isOrchestrating
  lastUpdated
  lastUsage    # { input_tokens, output_tokens, cache_read_input_tokens }
```

LRU + TTL 控制内存占用，按 `${sessionId}` 与 `${sessionId}:sub` 区分主代理与子代理。

## 5. 配置形态

旧项目使用 `~/.claude-code-router/config.json`（同时通过 `~/.edgeclaw/config.yaml` 桥接）。新项目应把 router 配置完全收敛到 `${PolitHome}/politdeck.yaml` 的统一结构中，可由 `${ProjectRoot}/.politdeck/politdeck.yaml` 与受控 ENV 覆盖。

参考结构：

```text
model:
  providers:
    openrouter:    { protocol: openai, url: ..., apiKey: ${OPENROUTER_API_KEY}, models: { ... } }
    deepseek:      { protocol: openai, url: ..., apiKey: ${DEEPSEEK_API_KEY}, models: { ... } }
    anthropic-main:{ protocol: anthropic, url: ..., apiKey: ${ANTHROPIC_API_KEY}, models: { ... } }

router:
  scenarios:
    default:        openrouter/anthropic-claude-sonnet-4-5
    background:     deepseek/deepseek-chat
    think:          openrouter/anthropic-claude-sonnet-4-5
    longContext:    openrouter/google-gemini-2-5-pro
    longContextThreshold: 60000
    webSearch:      openrouter/perplexity-sonar
  fallback:
    default:        [deepseek/deepseek-chat]
    longContext:    [openrouter/google-gemini-2-5-pro, deepseek/deepseek-chat]
  zeroUsageRetry:
    enabled: true
    maxAttempts: 5
  tokenSaver:
    enabled: true
    judge:  { provider: deepseek, model: deepseek-chat }
    defaultTier: SIMPLE
    tiers:
      SIMPLE:    { model: deepseek/deepseek-chat }
      MEDIUM:    { model: openrouter/anthropic-claude-sonnet-4-5 }
      COMPLEX:   { model: openrouter/anthropic-claude-opus-4 }
      REASONING: { model: openrouter/openai-gpt-5 }
    rules: [...]
    subagent:
      policy: judge
      model: deepseek/deepseek-chat
  autoOrchestrate:
    enabled: true
    mainAgentModel: openrouter/anthropic-claude-opus-4
    skillPath: ~/.politdeck/skills/orchestrate.md
    triggerTiers: [COMPLEX, REASONING]
    blockedTools: [mcp__browser-use__, WebSearch, WebFetch]
    slimSystemPrompt: true
  stats:
    enabled: true
    autoFlushSeconds: 60
    modelPricing:
      openrouter/anthropic-claude-sonnet-4-5: { input: 3.0, output: 15.0, cacheRead: 0.3 }
  customRouterPath: ~/.politdeck/extensions/myRouter.js
```

约定：

- 所有 model 引用统一 `provider/model` 形态，不再使用 `provider,model`，与 `agent.model` 字段保持一致。
- `apiKey` 支持 `${ENV_NAME}` 引用，由 `polit/config` 统一解析。
- `customRouterPath` 必须指向 PolitDeck Extension 协议下的入口，不再 `require()` 任意 JS 文件。
- 项目级覆盖只允许覆盖 `router.scenarios`、`router.tokenSaver`、`router.autoOrchestrate`、`router.stats` 段，不允许重新声明 provider apiKey。

## 6. 事件规范

router 必须把内部状态以稳定事件向 `agent` / `gateway` / `transcript` / `stats` 暴露：

```text
politdeck_router_request_received      # 收到模型请求，含 raw model / sessionId / metadata
politdeck_router_session_resolved      # sessionId 解析完成，含 source: metadata.user_id / sticky_lookup
politdeck_router_token_counted         # tokenizer 计数完成
politdeck_router_token_saver_started   # judge 开始
politdeck_router_token_saver_decided   # judge 决策完成（命中/失败/fallback tier）
politdeck_router_subagent_detected     # 子代理识别命中
politdeck_router_scenario_decided      # scenarioType 与目标 model 决策完成
politdeck_router_orchestrate_applied   # autoOrchestrate 注入/裁剪/瘦身完成
politdeck_router_provider_dispatched   # 发往 provider 的请求开始
politdeck_router_zero_usage_retry      # 零 usage 重试触发
politdeck_router_fallback_used         # fallback 命中
politdeck_router_response_completed    # provider 返回完成（含 usage、firstTokenMs、totalMs）
politdeck_router_failed                # 路由失败（含 reason）
```

事件命名禁止使用旧项目 `ccr_*` / `claude_*` / `tengu_*` 前缀。所有事件都应可被 `transcript` 写入，可被 `stats` 聚合，可被 `politdeck server` 通过 WebSocket 转发给客户端。

## 7. 安全与隔离

- API key 只能从 `polit/config` 解析后的内存配置读取，不允许从 `process.env` 直接读取业务 key。
- `customRouterPath`、`skillPath`、preset 文件的加载必须经过 PolitDeck Extension 加载器，按工作区根目录边界做沙箱判断。
- judge LLM 不允许复用业务 model 的 key 之外的隐式凭据；judge 失败必须 fallback 到 `defaultTier`，不允许中断 agent 请求。
- 长上下文阈值、tier 列表、orchestrator skill 都属于可观察行为，不允许通过 ENV 隐式覆盖；只能由 `polit/config` 注入。
- token stats 写盘只允许写入 `${PolitHome}/cache/router/stats/`，不允许沿用旧项目散落路径。

## 8. 可观察性

`router` 必须可被以下方式观察：

- `politdeck server` WS：实时 router 事件流。
- `politdeck` CLI：`politdeck router stats` 命令打印 sessions / hourly / summary。
- `politdeck` CLI：`politdeck router decide --dry-run --request <fixture.json>` 在不发请求的前提下打印 RouterDecision，用于排查路由策略。
- `transcript`：每个 turn 写入 router 决策快照。
- 调试：保留 `POLITDECK_ROUTER_DEBUG_DUMP` 环境变量，把 RouterDecision 与最终 provider request body 写入 `${PolitHome}/cache/router/debug/`，对应旧项目 `CCR_DEBUG_DUMP`。

## 9. 与新项目其他模块的边界

- `agent`：调用 `router.decide(request)` 拿到 RouterDecision，再交给 `model` 实际发送请求；不直接读 `Router` 配置。
- `model`：负责 transport / SSE 解析 / canonical event 归一化。`router` 不再自己实现 fetch、SSE buffer、错误归一化，转而消费 `model.stream()` / `model.complete()` 的结果，把 fallback、retry、stats 包在外层。
- `polit/config`：唯一配置源。router 启动时从 PolitConfigSnapshot 取出 `router` 段，热重载时按 `runtime-live`、`next-request`、`next-runtime` 分类处理（详见 `[../polit-config/](../polit-config/)`）。
- `gateway`：把 router 决策与执行事件透传给 client adapter。
- `extension`：customRouter、preset、orchestrator skill 都通过 extension 协议注册，不允许 `require()` 任意磁盘路径。

## 10. 长期目标与第一版边界

第一版必须实现：

- 多 provider + scenario 路由（default / background / think / longContext / webSearch）。
- `provider/model` 显式选定。
- token-based 长上下文路由。
- subagent 识别（CCR tag 与 missing Agent tool 两种方式）。
- LRU + TTL 的 sticky session state。
- TokenSaver judge 分流（含 SIMPLE/MEDIUM/COMPLEX/REASONING tier、subagent policy）。
- AutoOrchestrate 主代理 prompt 注入、工具裁剪、system slim、tool_result 重写。
- fallback chain。
- zero-usage retry。
- 基础 token stats（session / hourly / global）。
- 双形态：in-process（agent loop 直接调用）与 HTTP（兼容 Anthropic Messages 客户端，用于桥接外部 Claude Code CLI 等场景）。

第一版可暂缓：

- preset marketplace / 远程 registry。
- 22 个 transformer 全量迁移（先迁移 OpenRouter / Anthropic / OpenAI / DeepSeek 与 ToolUse、Reasoning、SamplingControl 等核心几个）。
- huggingface / api tokenizer（先用 tiktoken）。
- token speed plugin。
- 复杂 webhook output sink。

第一版禁止：

- 直接复用旧 `server.cjs` 打包结果。
- 直接读取 `~/.claude-code-router/config.json`。
- 在 router 内部出现 `claude` / `tengu` / `ccr` 类业务前缀。
- 在 router 内部直接写文件、改 `process.env`、注入 `globalThis.fetch`（fetch 拦截只允许在 `politdeck server` 入口启用，不在 router 模块内部默认开启）。

## 11. 与产品总规格的对齐

router 的能力必须与 `[../rewrite-plan/01-product-specification.md](../rewrite-plan/01-product-specification.md)` 中下列章节保持一致：

- “ModelRequest”：router 不引入新的请求字段，所有路由元数据写在 `metadata` 或 `RouterDecision` 上下文中。
- “运行时事件规范”：router 事件命名、事件触发顺序与产品总事件流一致。
- “等价能力要求”：router 的 fallback、token saver、orchestrate、subagent 行为等价于旧项目可观察行为，不复制其 UI 与实验开关。
