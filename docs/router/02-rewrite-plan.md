# Router 模块重写方案

本文结合 `[01-product-specification.md](./01-product-specification.md)` 中沉淀的 CCR 能力清单与新项目 `src/` 现状，给出 PilotDeck `router` 模块的重写方案：目标架构、模块切分、与既有模块的集成方式、命名迁移规则、实施任务、关键设计决策、风险与验收标准。

新项目中 router 是**纯内置模块**，与 `model` / `tool` / `permission` 同级。它不暴露 HTTP 端口，不监听 socket，不打包成独立可执行文件，不再实现 Anthropic Messages 兼容 server。所有调用都来自同进程内的 `agent` / `gateway` / `cli`，旧项目 CCR 的 Fastify server、`server.cjs` 打包产物、`installFetchInterceptor()` 方案都不迁移。

## 1. 当前状态与迁移前对照

当前 `src/router/` 已落地为内置控制平面：`createRouterRuntime()` 持有 scenario、fallback、zero-usage retry、TokenSaver、AutoOrchestrate、stats 和 custom router 接口；`AgentLoop` 通过 `dependencies.router.stream()` 调用模型流，`AgentRuntimeConfig` 不再持有 `fallbackProvider` / `fallbackModel`，旧 `AgentRecoveryPolicy` 也已删除。`pilot/config` 已接入 `router` 段，`createLocalGateway()` 会为每个 project runtime 创建 `ModelRuntime` 和 `RouterRuntime`。

下面的“迁移前”对照保留用于解释为什么 router 要从 agent fallback 中拆出，不再代表当前源码：

迁移前 `src/` 中和 router 相关或会被 router 复用的模块如下：

```text
src/
  agent/
    runtime/AgentRuntimeConfig.ts        # 迁移前：provider/model + fallbackProvider/fallbackModel
    runtime/AgentRuntimeDependencies.ts  # 迁移前：AgentModelRuntime 只暴露 stream(request, signal?)
    loop/AgentLoop.ts                    # 迁移前：直接读 config.provider/model + dependencies.model.stream()
    loop/AgentRecoveryPolicy.ts          # 迁移前 fallback 实现（仅依据 retryable + prompt_too_long）
    session/AgentSession.ts
  model/
    ModelRuntime.ts                      # createModelRuntime(config) -> stream/complete/getCapabilities
    streaming/streamModel.ts             # 真实 fetch + SSE
    config/parseModelConfig.ts           # 校验 model 配置段
    protocol/canonical.ts                # CanonicalModelRequest/Event/Response/...
    providers/registry.ts                # protocol -> adapter
  pilot/
    config/types.ts                      # 迁移前：PilotConfig / PilotRawConfig / PilotAgentConfig.fallbackModel
    config/loadPilotConfig.ts            # 迁移前：读 YAML + ENV (PILOT_AGENT_MODEL / PILOT_AGENT_FALLBACK_MODEL)
    config/parseGatewayConfig.ts         # parseGatewayConfig + parseAdaptersConfig（router 配置应同款）
    config/parseMemoryConfig.ts
    config/classifyChanges.ts            # 路径前缀 -> change class（目前只识别 agent./model./extension.*）
    paths.ts                             # PilotHome / PilotConfigPath / PilotCacheDir
  gateway/
    Gateway.ts
    SessionRouter.ts                     # 注意：这是“会话路由器”，不是 LLM router
    client/InProcessGateway.ts
    server/                              # WS gateway server
  extension/
    contributions/                       # Command/Hook/Tool/Prompt/Mcp/PermissionRule（暂无 Router）
    plugins/                             # PluginRuntime / loader / discovery
    hooks/                               # HookRuntime
  lifecycle/                             # LifecycleRuntime / Observer，router 事件应在此挂接
  cli/
    pilotdeck.ts                         # 子命令 server / tui / cli
    createLocalGateway.ts                # 迁移前：注入 dependencies.model；fallbackProvider/fallbackModel 桥接
```

值得注意的几点：

- `src/gateway/SessionRouter.ts` 已经占用 `SessionRouter` 这个名字，含义是“按 sessionKey 路由到 AgentSession”，与本文的 LLM router 不同。重写时必须避免命名冲突。
- 当前 fallback 配置实际上分布在三处，全都需要随重写一并迁移：
  - `src/pilot/config/types.ts#PilotAgentConfig.fallbackModel`：YAML 入口 `agent.fallbackModel`。
  - `src/pilot/config/loadPilotConfig.ts` 中 `PILOT_AGENT_FALLBACK_MODEL` 环境变量覆盖。
  - `src/agent/runtime/AgentRuntimeConfig.ts#fallbackProvider/fallbackModel`：runtime config，由 `src/cli/createLocalGateway.ts` L133-134 从 `agent.fallbackModel` 桥接。
  - `src/agent/loop/AgentRecoveryPolicy.ts`：唯一消费者（仅依据 `retryable` + prompt_too_long 决定是否切 fallback model）。
- 当前 AgentLoop 直接持有 `dependencies.model: AgentModelRuntime`（只有 `stream`），并自带 `AgentRecoveryPolicy`，没有 scenarioType / tier 概念。router 模块需要把决策结果回灌给这层，agent deps 也应改为持有 `router: RouterRuntime`。
- `src/agent/runtime/AgentRuntimeDependencies.ts#AgentModelRuntime` 只暴露 `stream(request, signal?)`，没有 `complete()`；这只是 agent 视角的窄接口。router 内部要用的是 `src/model/ModelRuntime`（含 `stream/complete/getCapabilities`），不是这个窄接口。
- `src/model/` 已经拥有 canonical request / response / stream 协议、provider registry、SSE 解析、错误归一化。**router 不再实现自己的 transport，所有上游网络请求必须经由 `src/model/` 完成。**
- `src/pilot/config/` 已经有 `PilotConfig`、`PilotRawConfig`、热重载、change class 分类、redact、diagnostics、`PILOT_AGENT_*` 环境变量覆盖。router 配置必须复用这一套；新增 router 段时 `PilotRawConfig`、`PilotConfig`、`classifyChanges.ts`、`loadPilotConfig.ts` 都需要同步扩展。
- `src/extension/contributions/` 当前只有 `CommandContribution` / `HookContribution` / `ToolContribution` / `PromptContribution` / `McpContribution` / `PermissionRuleContribution` 六类，**没有** router 相关 contribution。customRouter 接入要新增一类。
- `src/lifecycle/` 提供 `LifecycleRuntime` / `LifecycleObserver`，router 事件应该走这里（与现有 hook 事件并行），而不是另起一套发布渠道。
- 旧 CCR 中的 22 个 transformer 大部分功能已经在 `src/model/providers/anthropic/*` 和 `src/model/providers/openai/*` 中以协议适配器形态存在。**只把 model 模块无法表达的 transformer 留在 router 层。**

## 2. 目标架构

新项目中的 router 是一个**纯控制平面内置模块**：决定“这次请求发去哪”和“需要做哪些上下文层面的改写”，不持有 socket、不监听端口、不写文件（除 stats 落盘），由 agent loop 在同进程内通过函数调用直接消费。

调用关系简图：

```text
agent.AgentLoop
  -> router.decide(request, ctx)        # 纯函数：返回 RouterDecision
       -> router.scenario.classify()
       -> router.tokenSaver.judge()      # 调用 model.complete() (judge model)
       -> router.subagent.detect()
       -> router.orchestrate.apply()     # 改写 messages/system/tools (in place of decision.mutations)
  -> router.execute(decision, request, ctx)
       -> model.stream(canonicalRequest) / model.complete(canonicalRequest)
       -> router.zeroUsageRetry.wrap()
       -> router.fallback.wrap()
       -> router.stats.observe()
       -> emit pilotdeck_router_* events
  -> agent loop consumes CanonicalModelEvent
```

`decide()` 与 `execute()` 拆开有两个目的：

- 让上层（agent / gateway / CLI dry-run）可以只调用 `decide()` 不发实际请求，便于排查路由策略与写测试。
- 让 fallback / zero-usage retry 这种“需要重新走一次 transformer + transport”的逻辑只发生在 `execute()` 内，避免和 `decide()` 的纯逻辑混在一起。

## 3. 目录结构

源码目录：

```text
src/router/
  index.ts
  RouterRuntime.ts                # createRouterRuntime(config, deps) 入口
  protocol/
    decision.ts                   # RouterDecision / RouterScenarioType / SessionRoutingState
    events.ts                     # pilotdeck_router_* event union
    errors.ts                     # RouterError, RouterConfigError
  config/
    parseRouterConfig.ts          # 从 PilotConfig.router 段产出 RouterConfig
    schema.ts                     # zod / 自家校验
    resolveProviderRef.ts         # 把 "openrouter/anthropic-claude-sonnet-4-5" 解析到 ModelConfig
  scenario/
    decideScenario.ts             # 显式 provider/model / longContext / subagent / web / think / haiku-bg
    longContextThreshold.ts
    subagentDetector.ts
  tokenSaver/
    classifyAndRoute.ts
    generateJudgePrompt.ts
    parseTier.ts
    extractLastUserMessage.ts
  orchestrate/
    applyOrchestration.ts         # prompt 注入 / tool stripping / system slim
    rewriteAsyncAgentLaunched.ts  # 非 Claude orchestrator 的 tool_result 重写
    loadOrchestratePrompt.ts      # 从 extension 加载 skill 文件
  session/
    SessionRouterStore.ts         # LRU + TTL，记录 sticky tier/model + orchestrating
    sessionUsageCache.ts          # last-usage（供 longContext 判断使用）
  fallback/
    runFallbackChain.ts
  retry/
    zeroUsageRetry.ts
  stats/
    TokenStatsCollector.ts        # 写盘到 ${PilotCacheDir}/router/stats/
    pricing.ts
  customRouter/
    loadCustomRouter.ts           # 通过 extension 协议加载，不直接 require()
```

除了 `src/router/` 下的新增文件外，还需要在以下既有模块中新增/扩展文件：

```text
src/pilot/config/
  parseRouterConfig.ts            # 新增；与 parseGatewayConfig.ts / parseMemoryConfig.ts 同款风格
src/extension/contributions/
  RouterContribution.ts           # 新增；为 customRouter 提供 contribution 类型
src/lifecycle/protocol/events.ts  # 扩展；增加 pilotdeck_router_* 事件（或在 router 模块自带 EventBus 与 lifecycle 桥接）
```

测试目录见 `[03-testing-guide.md](./03-testing-guide.md)`。

旧项目以下文件**不迁移**：

- `src/router/server.ts` / `server.cjs` / `server.cjs.map`：Fastify server，新项目无 HTTP 形态。
- `src/router/build.mjs`：cjs 打包脚本。
- `src/router/test-pipeline.ts` / `test-router.ts` / `test-routing.ts`：旧项目自带的脚本式测试，由 `tests/router/` 下的 Bun test 套件取代。
- `src/router/src/api/routes.ts` / `middleware.ts`：HTTP 路由处理。
- `src/router/src/server.ts` 中 `Server` 类、`registerNamespace`、`addHook`、`init/listen/start` 等 Fastify 生命周期 API。
- `src/router/src/pipeline.ts` 中 `installFetchInterceptor()`：新项目不拦截 `globalThis.fetch`，agent loop 直接调用 `router.execute()`。
- `src/router/shared/preset/marketplace.ts` / `install.ts` / `export.ts`：preset 远程市场不在本次重写范围。

## 4. 命名迁移

| 旧语义 | PilotDeck 命名 |
| --- | --- |
| `CCR` / `Claude Code Router` | `PilotDeck Router` / `pilotdeck-router` |
| `Router.default` / `Router.background` 等 | `router.scenarios.default` / `router.scenarios.background` |
| `tokenSaver` 配置（保留） | `router.tokenSaver`（结构调整：`judgeProvider` + `judgeModel` 合并为 `judge: { provider, model }`） |
| `autoOrchestrate` | `router.autoOrchestrate` |
| `provider,model` 字符串 | `provider/model` |
| `<CCR-SUBAGENT-MODEL>...</CCR-SUBAGENT-MODEL>` | `<pilotdeck-subagent-model>...</pilotdeck-subagent-model>` 或更通用的 `metadata.subagentModel` |
| `CCR_DEBUG_DUMP` env | `PILOTDECK_ROUTER_DEBUG_DUMP` |
| `~/.claude-code-router/config.json` | `${PilotHome}/pilotdeck.yaml` 中 `router` 段 |
| `~/.claude/projects/${project}/${session}.json` 项目级 Router 覆盖 | 由 `pilot/config` 项目级 YAML 覆盖 + `session.routerOverride`（写入 `session-state.json`） |
| `tengu_*` / `ccr_*` 事件 | `pilotdeck_router_*` |
| `getGlobalStatsCollector()` 全局单例 | `RouterRuntime.stats`，由 runtime 拥有；不再使用模块级 globalThis 单例 |
| Fastify `Server` / `registerNamespace` / `addHook` | 不存在；agent loop 直接调用 `router.decide()` / `router.execute()` |
| `installFetchInterceptor(sentinelBaseUrl)` | 不存在；不拦截 `globalThis.fetch` |
| `pipeline.processRequest(url, init, services, realFetch)` | 不存在；其内部责任拆分为 `router.execute()` + `model.stream()` |

类型示例：

```ts
export type PilotDeckRouterDecision = {
  provider: string;
  model: string;
  scenarioType: PilotDeckRouterScenarioType;
  tokenSaverTier?: string;
  isSubagent: boolean;
  orchestrating: boolean;
  mutations: PilotDeckRouterMutationsLog;
  resolvedFrom: "explicit" | "scenario" | "tokenSaver" | "custom" | "fallback";
};
```

禁止：

- 在源码或测试中以 `CCR`、`ccr`、`Claude`、`claude` 作为新增类型 / 事件 / 配置 key 的前缀。
- 引入 `fastify` / `@fastify/cors` 作为 `src/router/` 的依赖。
- 把 fastify 的 `_server`、`req.provider`、`req.model` 这种隐式增强带过来。新项目应通过显式参数传 RouterDecision。
- 把 `globalThis.fetch` 替换成 router 的 in-process pipeline。

## 5. 配置与 pilot/config 集成

router 配置由 `pilot/config` 模块负责加载、校验、redact、热重载。`src/pilot/config/types.ts` 中应新增：

```ts
export type PilotRouterScenariosConfig = {
  default: PilotAgentModelSelection;
  background?: PilotAgentModelSelection;
  think?: PilotAgentModelSelection;
  longContext?: PilotAgentModelSelection;
  longContextThreshold?: number;
  webSearch?: PilotAgentModelSelection;
};

export type PilotRouterTokenSaverConfig = {
  enabled: boolean;
  judge: PilotAgentModelSelection;
  defaultTier: string;
  tiers: Record<string, { model: PilotAgentModelSelection; description?: string }>;
  rules?: string[];
  subagent?: {
    policy: "skip" | "judge" | "inherit" | "fixed";
    model?: PilotAgentModelSelection;
  };
};

export type PilotRouterAutoOrchestrateConfig = {
  enabled: boolean;
  mainAgentModel?: PilotAgentModelSelection;
  skillPath?: string;            // 通过 extension 解析后变成可读 skill id
  triggerTiers?: string[];
  blockedTools?: string[];
  slimSystemPrompt?: boolean;
};

export type PilotRouterConfig = {
  scenarios: PilotRouterScenariosConfig;
  fallback?: Partial<Record<PilotDeckRouterScenarioType, PilotAgentModelSelection[]>>;
  zeroUsageRetry?: { enabled: boolean; maxAttempts: number };
  tokenSaver?: PilotRouterTokenSaverConfig;
  autoOrchestrate?: PilotRouterAutoOrchestrateConfig;
  stats?: PilotRouterStatsConfig;
  customRouter?: { extensionId: string };
};

export type PilotConfig = {
  agent: PilotAgentConfig;
  model: ModelConfig;
  router?: PilotRouterConfig;     // 新增
  extension: PilotExtensionConfig;
  memory?: PilotMemoryConfig;
  gateway?: PilotGatewayConfig;
  adapters?: PilotAdaptersConfig;
};
```

热重载分类：

| 字段路径 | change class | 说明 |
| --- | --- | --- |
| `router.scenarios.*` | `next-request` | 下一次 `decide()` 即生效。 |
| `router.fallback.*` | `next-request` | 下一次 `execute()` 即生效。 |
| `router.tokenSaver.tiers.*.model` | `next-request` | sticky 状态下次过期或下次 judge 命中时刷新。 |
| `router.tokenSaver.judge.*` | `runtime-live` | judge 通道立刻改用新 provider/model。 |
| `router.autoOrchestrate.skillPath` | `next-runtime` | 已经在 orchestrating 的 session 保留旧 prompt，新 session 使用新 prompt。 |
| `router.zeroUsageRetry.maxAttempts` | `next-request` | |
| `router.stats.enabled` | `restart-required` | 涉及写盘文件句柄，重启再生效。 |
| `router.customRouter.extensionId` | `restart-required` | extension 加载发生在启动时。 |

`parseRouterConfig()` 落在 `src/pilot/config/parseRouterConfig.ts`，与 `parseGatewayConfig.ts` / `parseMemoryConfig.ts` 同款风格，必须：

- 校验 scenarios.default 的 provider/model 在 `model.providers` 中存在。
- 校验 tokenSaver.tiers 中每个 model 都解析得到。
- 校验 fallback 链里的 model 都解析得到。
- 校验 longContextThreshold 为正整数。
- 把 `provider/model` 字符串解析为 `{ provider, model }` 元组，返回结构化结果，不再让 router runtime 反复 split。
- 解析失败时抛出 `PilotConfigError`，与 `pilot/config` diagnostics 集成。

围绕这个新解析器，`src/pilot/config/` 中其它文件也要同步修改：

- `types.ts#PilotRawConfig` 增加 `router?: unknown` 字段，让 YAML 顶层 `router` 段能被透传到 `parseRouterConfig`。
- `types.ts#PilotConfig` 增加 `router?: PilotRouterConfig`（已在上面的 TypeScript 片段中给出）。
- `loadPilotConfig.ts` 在调用 `parseGatewayConfig` / `parseMemoryConfig` 之后调用 `parseRouterConfig(rawConfig.router, modelConfig, diagnostics)`，把结果挂到 `PilotConfig.router`。
- `loadPilotConfig.ts#ENV_CONFIG_OVERRIDES` 中的 `PILOT_AGENT_FALLBACK_MODEL` 项 **删除或迁移**：fallback 现在归 router 段管，旧 env 名称如需保留兼容，应由 `parseRouterConfig` 在解析阶段读取并写入 `router.fallback.default[0]`，并发出 deprecation diagnostic。
- `classifyChanges.ts` 增加对 `router.*` 路径的分支：按 §5 表把 `router.scenarios.*` / `router.fallback.*` / `router.tokenSaver.tiers.*.model` / `router.zeroUsageRetry.maxAttempts` 标为 `next-request`，`router.tokenSaver.judge.*` 标为 `runtime-live`，`router.autoOrchestrate.skillPath` 标为 `next-runtime`，`router.stats.enabled` / `router.customRouter.extensionId` 标为 `restart-required`；其余 `router.*` 路径默认 `next-runtime`。
- `redact.ts` 已经 redact `model.providers.*.apiKey`；`tokenSaver.judge` 引用的是同一份 provider，不会引入新的 secret 字段，无需额外 redact 规则。

## 6. 与 model 模块的集成

router 不再实现 fetch、SSE buffer、错误归一化、headers 注入、auth。所有发往上游 provider 的请求都经由 `src/model/`。

router 内部依赖的是 `src/model/ModelRuntime`（来自 `createModelRuntime(pilotConfig.model)`），它同时暴露 `stream(request)` / `complete(request)` / `getCapabilities(provider, model)`。这与 `src/agent/runtime/AgentRuntimeDependencies.ts#AgentModelRuntime` 那个**只暴露 `stream` 的窄接口**不同：

- 窄接口 `AgentModelRuntime` 是 agent loop 当前使用的形态，重写后会被替换为 `dependencies.router: RouterRuntime`，不再直接出现在 agent deps 里。
- 完整接口 `ModelRuntime` 由 router runtime 持有；judge 调用通过 `modelRuntime.complete(request)`（不需要流式），主请求通过 `modelRuntime.stream(request)`。

具体接口：

```ts
export type RouterRuntimeDeps = {
  modelRuntime: ModelRuntime;          // createModelRuntime(pilotConfig.model)
  judgeRuntime?: ModelRuntime;          // 通常等同 modelRuntime；测试中可注入 fake
  tokenizer?: Tokenizer;                // 复用 src/model 的 tokenizer 或独立 tiktoken
  now?: () => Date;
  uuid?: () => string;
  logger?: Logger;
  events?: EventBus;
  extension?: ExtensionRuntime;          // 加载 customRouter / orchestrator skill
  cache?: { policy: "memory" | "disk"; dir?: string };
};
```

`router.execute(decision, request, ctx)` 内部：

1. 把 RouterDecision 反向作用到 `request`：替换 `provider` / `model`，可选改写 `messages` / `system` / `tools`（来自 orchestrate 决策）。
2. 调用 `modelRuntime.stream(request)` 或 `modelRuntime.complete(request)`：
   - 流式：在 `text_delta` 出现且 `usage` 显示零 token 时触发 zero-usage retry。
   - 非流式：解析 response，零 token 触发重试。
3. 任何 `error` event / `ModelProviderError` 进入 fallback 链：
   - 把 `decision.scenarioType` 对应的 fallback list 逐个尝试。
   - 每次重新跑 RouterDecision.mutations？**不重新跑 orchestrate**（避免重复注入），只替换 provider/model 与 transformer。
4. 所有 CanonicalModelEvent 透传给 caller（agent loop），同时 `router.stats` 在事件上做副本观测，不修改事件。

这样 router 自己不知道任何 provider 协议细节，model 模块决定如何把 canonical request 序列化到 Anthropic / OpenAI 格式。

### 6.1 旧 22 个 transformer 的归宿

按照下表分流：

| 旧 transformer | 新位置 | 说明 |
| --- | --- | --- |
| `anthropic.transformer` | `src/model/providers/anthropic/` | 已经是 protocol 适配器，router 不再单独调用。 |
| `openai.transformer` | `src/model/providers/openai/` | 同上。 |
| `openai.responses.transformer` | `src/model/providers/openai/responses/`（暂缓） | 仅当配置选用 `protocol: openai-responses` 时启用。 |
| `openrouter.transformer` | `src/model/providers/openai/openrouter.ts`（attribution headers + 个别字段映射） | 由 model 模块在序列化时根据 hostname=openrouter.ai 自动启用。 |
| `deepseek.transformer` / `cerebras.transformer` / `groq.transformer` / `vercel.transformer` | `src/model/providers/openai/<vendor>.ts` | 都是 OpenAI 兼容协议下的字段微调，归 model 模块。 |
| `vertex-claude.transformer` / `vertex-gemini.transformer` / `gemini.transformer` | 暂缓，等接入 Vertex / Gemini protocol 时再加。 | |
| `cleancache.transformer` | model 模块响应 normalizer。 | |
| `enhancetool.transformer` / `tooluse.transformer` | `src/model/providers/<vendor>/toolUse.ts`（model adapter 内部） | 因为它修改的是 model request body，归 model 模块。 |
| `forcereasoning.transformer` / `reasoning.transformer` | `src/model/providers/<vendor>/reasoning.ts` | 同上。 |
| `maxtoken.transformer` / `maxcompletiontokens.transformer` | model 模块内的 capabilities 上限裁剪。 | |
| `sampling.transformer` / `streamoptions.transformer` / `customparams.transformer` | model 模块内 request builder 的可选项。 | |

router 自身只保留：

- scenarioType 决策。
- subagent 检测。
- TokenSaver judge。
- AutoOrchestrate 改写（messages/system/tools）。
- fallback 链。
- zero-usage retry。
- stats。
- customRouter 钩子。

## 7. 与 agent / gateway 的集成

### 7.1 agent loop 调用方式

`agent/loop/AgentLoop.ts` 现在直接拿 `AgentRuntimeConfig.provider/model` 调用 model runtime。重写后改为：

```ts
const decision = await router.decide({
  request: canonicalRequest,
  sessionId: session.id,
  isMainAgent: !session.isSubagent,
  metadata: { lastUsage: session.lastUsage },
});

session.applyRouterDecision(decision);

for await (const event of router.execute(decision, canonicalRequest, ctx)) {
  yield event;
}
```

伴随改动（必须一并落地，否则 fallback 会变成 router 与 AgentRecoveryPolicy 双层）：

- `src/agent/loop/AgentRecoveryPolicy.ts` **删除**。它当前承载的 `retryable + prompt_too_long → 切 fallback` 逻辑迁入 `src/router/fallback/runFallbackChain.ts`；prompt_too_long 这类不可重试错误由 router 直接透传给 agent，由 agent 决定是否记 `agent_prompt_too_long`。
- `src/agent/loop/AgentLoop.ts`：构造函数里的 `this.recoveryPolicy = new AgentRecoveryPolicy(...)` 与 `decideForModelError()` 调用一并删除；`createModelRequest()` 仍生成 CanonicalModelRequest，但不再读 `this.config.provider/model` 直接发请求，而是把 request 传给 `router.decide()`，再用 `router.execute()` 替换原来的 `dependencies.model.stream()` 循环。
- `src/agent/runtime/AgentRuntimeConfig.ts`：删除 `fallbackProvider` / `fallbackModel` 两个字段（fallback 单一来源 = `PilotRouterConfig.fallback.default`）。
- `src/agent/runtime/AgentRuntimeDependencies.ts`：把 `model: AgentModelRuntime` 替换为 `router: RouterRuntime`。`AgentModelRuntime` 类型可保留为 router 内部的私有 helper，但不再出现在 agent deps 公共契约里。
- `src/pilot/config/types.ts#PilotAgentConfig.fallbackModel` **删除**；YAML 中 `agent.fallbackModel` 的迁移路径是 `router.fallback.default`。
- `src/pilot/config/loadPilotConfig.ts#ENV_CONFIG_OVERRIDES` 里的 `PILOT_AGENT_FALLBACK_MODEL` **删除或在 `parseRouterConfig` 中以 deprecation 兼容路径接住**（详见 §5）。
- `src/cli/createLocalGateway.ts` L133-134 那段从 `agent.fallbackModel.provider/model` 桥接到 `AgentRuntimeConfig.fallbackProvider/fallbackModel` 的代码 **删除**；createLocalGateway 改为构造 `RouterRuntime` 并注入到 `dependencies.router`。`fallbackProvider` / `fallbackModel` 不再写入 agent config。

### 7.2 customRouter 接入

旧项目 `customRouterPath` 走 `require()`。新项目改成 extension：

```ts
export type PilotDeckCustomRouter = {
  id: string;
  decide(input: CustomRouterInput): Promise<Partial<RouterDecision> | undefined>;
};
```

`router.decide()` 在内置策略前先尝试 custom router；返回 `undefined` 就 fallthrough 到内置策略。`extension` 模块负责沙箱、签名、错误隔离。

落地位置：

- 新建 `src/extension/contributions/RouterContribution.ts`，与现有 `CommandContribution.ts` / `HookContribution.ts` / `ToolContribution.ts` / `PromptContribution.ts` / `McpContribution.ts` / `PermissionRuleContribution.ts` 平级。
- 在 `src/extension/index.ts` 暴露 `RouterContribution` 类型。
- `src/extension/plugins/` 中的 `PluginRuntime` / `PluginRegistry` 增加对 router contribution 的发现与缓存（与已有 contribution 的处理方式一致）。
- router 端通过 `RouterRuntimeDeps.extension.lookupRouter(extensionId)` 拿到 `PilotDeckCustomRouter` 实例。

### 7.3 gateway 透传

`gateway/Gateway.ts` 应把 RouterDecision 与 router 事件原样转发到 `pilotdeck server` 的 WS 通道，保证 CLI / TUI / Web 都能看到“当前 turn 由哪个 model 服务”。

`SessionRouter`（gateway）和 `RouterRuntime`（LLM router）通过 `AgentSession` 解耦：

```text
gateway.SessionRouter.route(sessionKey)
  -> AgentSession (each session owns its own AgentLoop)
       -> router.RouterRuntime  (shared instance)
```

router runtime 是单实例（一个进程一份），所有 AgentSession 通过它路由请求；session-level sticky 状态由 router 内部 `SessionRouterStore` 按 `sessionId` 维护。

### 7.4 CLI 集成

`pilotdeck` CLI 提供两个 router 相关命令，作为内置模块的诊断入口（不需要任何 HTTP 端点）：

- `pilotdeck router decide --request <fixture.json>`：本地调用 `router.decide()`，打印 RouterDecision，便于排查路由策略。
- `pilotdeck router stats`：打印当前进程 `RouterRuntime.stats` 的 sessions / hourly / global 聚合，等价于旧项目 `/api/stats/*` HTTP 接口的功能。

## 8. 实施任务

router 模块作为整体一次落地，不再划分阶段，所有任务在同一个里程碑内完成。任务清单按依赖顺序排列，便于实现时分块推进；上层任务必须在依赖完成后再开始。

### 8.1 类型与配置

- 在 `src/router/protocol/` 下定义 `RouterDecision`、`RouterScenarioType`、`SessionRoutingState`、`PilotDeckRouterMutationsLog`、`RouterError`、`RouterConfigError`。
- 在 `src/router/protocol/events.ts` 定义 `pilotdeck_router_*` 事件 union。
- 在 `src/router/config/` 下实现 `parseRouterConfig()`、`schema.ts`、`resolveProviderRef()`，并把 `PilotRouterConfig` 注册进 `src/pilot/config/types.ts`。
- 在 `src/pilot/config/classifyChanges.ts` 中按 §5 的表补齐 router 字段的 change class。

### 8.2 决策内核

- `src/router/scenario/decideScenario.ts`：实现 §1 中 `01-product-specification.md` 列出的全部 scenario 优先级（显式 / longContext / subagent tag / haiku-bg / webSearch / think / default）。
- `src/router/scenario/longContextThreshold.ts`：实现“tokenCount > threshold”和“lastUsage.input_tokens > threshold && tokenCount > 20000”双重判断。
- `src/router/scenario/subagentDetector.ts`：兼容 `<CCR-SUBAGENT-MODEL>` / `<pilotdeck-subagent-model>` 与 missing Agent tool 两种识别方式。
- `src/router/session/SessionRouterStore.ts`：LRU(500) + TTL(3600s)，区分 `${sessionId}` 与 `${sessionId}:sub`。
- `src/router/session/sessionUsageCache.ts`：保存上一次 usage 供 longContext 判断使用。

### 8.3 TokenSaver

- `src/router/tokenSaver/generateJudgePrompt.ts`、`parseTier.ts`、`extractLastUserMessage.ts`：保留与旧实现兼容的 prompt 生成与解析。
- `src/router/tokenSaver/classifyAndRoute.ts`：通过 `judgeRuntime.complete()` 调用 judge，独立 timeout（默认 5s），失败回落 `defaultTier` 并发射 `pilotdeck_router_token_saver_failed`。
- subagent policy 四种模式（skip / judge / inherit / fixed）实现完整。

### 8.4 AutoOrchestrate

- `src/router/orchestrate/applyOrchestration.ts`：主代理 prompt 注入（user 消息 system-reminder）、blockedTools 裁剪、`slimSystemPrompt`（保留首 block `cache_control` 与 memory keyword block）；子代理走 TokenSaver tier。
- `src/router/orchestrate/rewriteAsyncAgentLaunched.ts`：非 Claude orchestrator 的 `tool_result` 文案重写。
- `src/router/orchestrate/loadOrchestratePrompt.ts`：通过 extension 协议加载 skill 文件，加载失败回落内置 prompt。

### 8.5 执行链路

- `src/router/RouterRuntime.ts`：装配 deps，暴露 `decide()` / `execute()` / `stats` / `shutdown()`。
- `src/router/fallback/runFallbackChain.ts`：按 scenarioType 顺序尝试 fallback list，沿用 first decision 的 mutations。
- `src/router/retry/zeroUsageRetry.ts`：流式与非流式两种 zero-usage 重试，复用旧 maxAttempts=5 行为。
- `src/router/stats/TokenStatsCollector.ts`、`pricing.ts`：聚合 session / hourly / global，写盘到 `${PilotCacheDir}/router/stats/`，pricing 热更。

### 8.6 扩展接入

- `src/router/customRouter/loadCustomRouter.ts`：通过 `extension` 模块加载，类型化输入输出。
- `pilotdeck_router_custom_failed` / `pilotdeck_router_token_saver_failed` 等事件接入 `gateway` 与 `transcript`。

### 8.7 上层迁移

需要按以下文件清单一一处理（与 §1 / §5 / §7 中标注的依赖一致）：

- `src/pilot/config/types.ts`：扩展 `PilotRawConfig` 与 `PilotConfig` 增加 `router` 字段；删除 `PilotAgentConfig.fallbackModel`。
- `src/pilot/config/loadPilotConfig.ts`：调用 `parseRouterConfig`；从 `ENV_CONFIG_OVERRIDES` 中删除 `PILOT_AGENT_FALLBACK_MODEL`（或迁移到 router 段，发 deprecation diagnostic）。
- `src/pilot/config/classifyChanges.ts`：增加 `router.*` 路径分支。
- `src/agent/loop/AgentRecoveryPolicy.ts`：**删除**（fallback 逻辑收敛到 router）。
- `src/agent/loop/AgentLoop.ts`：去掉 `recoveryPolicy` 字段、`decideForModelError()` 调用与构造函数参数；改为通过 `dependencies.router.decide()` + `dependencies.router.execute()` 完成请求循环。
- `src/agent/runtime/AgentRuntimeConfig.ts`：删除 `fallbackProvider` / `fallbackModel` 字段。
- `src/agent/runtime/AgentRuntimeDependencies.ts`：把 `model: AgentModelRuntime` 替换为 `router: RouterRuntime`。
- `src/cli/createLocalGateway.ts`：删除 L133-134 的 `fallbackProvider` / `fallbackModel` 桥接；新增 `createRouterRuntime(snapshot.config.router, modelRuntime, deps)`，把 `RouterRuntime` 注入 `dependencies.router`，不再注入 `dependencies.model`。
- `src/cli/pilotdeck.ts`：注册 `pilotdeck router decide` / `pilotdeck router stats` 子命令。
- `src/gateway/Gateway.ts`：把 RouterDecision 与 router 事件透传到 WS gateway 协议帧（事件类型扩展走 `src/lifecycle/protocol/events.ts` 或 router 自带的 EventBus，二选一并保持一致）。
- `src/extension/contributions/RouterContribution.ts`、`src/extension/index.ts`、`src/extension/plugins/runtime/PluginRuntime.ts`：按 §7.2 增加 router contribution 发现与查询。
- 删除 / 弃用 `~/.claude-code-router/config.json` 与 `~/.claude/projects/` 路径相关代码（含 `searchProjectBySession()` 等）；改为读取 `pilot/config` 项目级配置。

### 8.8 测试落地

- 按 `[03-testing-guide.md](./03-testing-guide.md)` §4 / §6 落地单元测试与双边 parity 测试。
- `tests/router/` 下覆盖：config / scenario / subagent / tokenSaver / orchestrate / session / fallback / retry / runtime / customRouter / stats / parity。
- parity manifest 中 `must_match` 场景全部通过；`intentional_difference` 与 `deferred` 场景标注完整。

## 9. 关键设计决策

### 9.1 RouterDecision 是不可变快照

`decide()` 返回的对象只读，`execute()` 不再二次决策（除了 fallback 替换 provider/model）。原因：

- 让事件可重放。
- 让测试可在不发请求的情况下断言决策。
- 避免 orchestrate 在 fallback 阶段被重复注入。

### 9.2 mutations 显式记录

orchestrate 改写消息、瘦身 system、裁剪 tools 时必须把 mutation 元数据放进 `RouterDecision.mutations`，而不是直接改 `request` 后丢失。`execute()` 在真正发请求前根据 mutations 把改动应用到副本上：

```ts
type PilotDeckRouterMutationsLog = {
  systemPromptSlim?: { from: number; to: number; preservedKeywords: string[] };
  toolsStripped?: { before: number; after: number; patterns: string[] };
  orchestrationPromptInjected?: { tier: string; chars: number };
  asyncAgentLaunchedRewritten?: boolean;
  subagentTagStripped?: boolean;
};
```

### 9.3 session 状态独立

旧项目把 sticky session 用模块级 `LRUCache` 表达。新项目把它放进 `RouterRuntime` 实例：

- 测试可以创建多个 runtime 实例互不干扰。
- `pilot/config` 重启时整个 runtime 重建，不会有“旧 sticky 残留”。
- 多租户场景下不同 PilotConfig 进程间天然隔离。

### 9.4 拒绝模块级单例

旧 CCR 的 `getGlobalStatsCollector` / `setGlobalStatsCollector` / `pluginManager` 全是模块级 globals。新项目禁止再用：

- stats、custom router、orchestrator skill 都挂在 `RouterRuntime` 实例下。
- 跨 turn 共享通过 `RouterRuntimeDeps` 显式传入。

### 9.5 customRouter 必须 sandboxed

旧 `require(customRouterPath)` 任意 JS。新项目：

- 通过 `extension` 模块加载，类型化输入输出。
- customRouter 只能读 `RouterDecisionInput`，不能拿到 raw `req` / `res` / `process.env` / `globalThis.fetch`。
- customRouter 失败必须降级为内置策略，记录 `pilotdeck_router_custom_failed`。

### 9.6 仅内置模块，不暴露 HTTP 与 fetch interceptor

旧项目同时提供 HTTP 形态（Fastify server）与 in-process 形态（`installFetchInterceptor`），导致两条代码路径并存且容易行为分歧。新项目只保留**单一 in-process 形态**：

- 不引入 fastify、不监听端口、不维护 `/v1/messages` 等 HTTP 路由。
- 不替换 `globalThis.fetch`，agent loop 直接调用 `router.execute()`，由 `model.stream()` 负责真实网络请求。
- 旧 CCR 中等价于 `/api/stats/*` 的功能由 `pilotdeck router stats` CLI 子命令承载，必要时可由 `gateway` WS 协议帧实时转发，但不通过 HTTP REST。
- 第三方 Anthropic Messages 兼容客户端不在重写范围；如果将来确实需要兼容，应作为独立的 `apps/router-bridge`（或类似命名的可选 app）项目，复用本模块的 `RouterRuntime`，而不是把 HTTP 能力塞回 `src/router/`。

## 10. 风险与回退

| 风险 | 影响 | 控制措施 |
| --- | --- | --- |
| TokenSaver judge 调用失败 / 超时 | 主流程被阻塞 | judge 必须有独立 timeout（默认 5s），失败一律 fallback `defaultTier`，并发射 `pilotdeck_router_token_saver_failed` 事件。 |
| Orchestrate 改写破坏 prompt cache | 缓存命中率下降 | 复刻旧实现：`slimSystemPrompt` 保留首个 block 的 `cache_control`；只在 messages 头部注入 user 消息，避免触动 system blocks。 |
| 长上下文阈值与 tokenizer 不一致 | 错误的 longContext 路由 | 复用 `src/model/` 的 tokenizer。tokenizer 与 model 协议绑定，不让 router 自己选 tiktoken/huggingface。 |
| 旧 22 个 transformer 一次性迁移 | 工程量过大 | 按 §6.1 拆到 model 模块，仅迁移 anthropic / openai / openrouter / deepseek，其它放 backlog。 |
| sticky session 内存泄漏 | 长跑进程内存涨 | 沿用 LRU(500) + TTL(3600s)，并加 `runtime.shutdown()` 清理钩子。 |
| customRouter 兼容性 | 现有用户脚本失效 | 不保证旧 `customRouterPath` 可直接迁移，提供迁移指南：从 `module.exports = (req, config) => model` 改写为实现 `PilotDeckCustomRouter`。 |
| 第三方 Anthropic Messages 客户端无法直连 | 旧 CCR HTTP 用户迁移阻塞 | 在 README 中明确 PilotDeck 只服务自家 agent loop / gateway / CLI；如需对外 HTTP 兼容，作为独立 `apps/router-bridge` 单独立项，不在本模块范围。 |

## 11. 验收标准

router 重写完成后必须满足：

1. `src/agent/loop/AgentLoop.ts` 已经只通过 `dependencies.router.decide()` + `dependencies.router.execute()` 与 model 通信，不再直接读 `Router` 配置、不再持有 `dependencies.model`。
2. `src/agent/loop/AgentRecoveryPolicy.ts` 已删除；`src/agent/runtime/AgentRuntimeConfig.ts` 中 `fallbackProvider` / `fallbackModel` 已删除；`src/agent/runtime/AgentRuntimeDependencies.ts` 已把 `model` 替换为 `router`。
3. `src/pilot/config/types.ts` 中 `PilotAgentConfig.fallbackModel` 已删除；`PilotRawConfig` 与 `PilotConfig` 已新增 `router` 段；`loadPilotConfig.ts` 已不再读 `PILOT_AGENT_FALLBACK_MODEL`（或在 `parseRouterConfig` 内部以 deprecation 方式接住）。
4. `src/pilot/config/parseRouterConfig.ts` 已落地，与 `parseGatewayConfig.ts` / `parseMemoryConfig.ts` 同款风格；`classifyChanges.ts` 已识别 `router.*` 路径并按 §5 表给出正确 change class。
5. `src/cli/createLocalGateway.ts` 已不再桥接 `agent.fallbackModel` 到 `AgentRuntimeConfig.fallbackProvider/fallbackModel`，而是构造 `RouterRuntime` 并注入到 `dependencies.router`。
6. `src/extension/contributions/RouterContribution.ts` 已落地，并通过 `src/extension/index.ts` 与 `src/extension/plugins/runtime/PluginRuntime.ts` 暴露给 router runtime。
7. `src/router/` 下不存在任何 fastify / HTTP / `globalThis.fetch` 拦截相关代码；`package.json` 不引入 fastify 依赖。
8. `tests/router/` 下：
   - protocol / config / scenario / subagent / sticky-session / fallback / zero-usage / tokenSaver / orchestrate / customRouter / stats 单元测试全部通过。
   - 双边 parity 测试集中至少覆盖 `[03-testing-guide.md](./03-testing-guide.md)` §6 中标记 `must_match` 的场景。
9. `pilotdeck` CLI 提供 `pilotdeck router decide --request <fixture.json>` 与 `pilotdeck router stats` 命令，输出 RouterDecision 与统计数据，便于排查策略与诊断。
10. 启动新 `pilotdeck server` 不再依赖 `~/.claude-code-router/config.json` 与 `~/.claude/projects/` 路径，不再启动 router 自带的 HTTP 端口。
11. `tests/lifecycle-hooks-plugins/` 中 router 事件接入到 transcript / gateway / lifecycle / extension。
12. 文档：`[01-product-specification.md](./01-product-specification.md)` 中所有“第一版必须实现”的条目均落到代码并被测试覆盖。
