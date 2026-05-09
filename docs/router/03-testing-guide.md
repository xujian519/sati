# Router 测试方案

本文定义 PolitDeck `router` 模块的测试目标、测试目录、测试分层、单测命名规则、fake 依赖用法和**双边 parity 测试**写法。它结合 `[01-product-specification.md](./01-product-specification.md)` 中沉淀的产品行为基线和 `[02-rewrite-plan.md](./02-rewrite-plan.md)` 中给出的目录结构与接口，确保新项目 `src/router/` 与旧项目 `third-party/claude-code-main/src/router/` 在相同输入下产生相同的可观察行为。

## 1. 测试目标

router 测试必须保证以下五件事：

- **配置稳定**：`PolitConfig.router` 段在合法/非法输入下产生稳定的解析结果与 diagnostics。
- **决策稳定**：相同输入下 `RouterRuntime.decide()` 返回的 `RouterDecision` 字段稳定（provider、model、scenarioType、tokenSaverTier、isSubagent、orchestrating、mutations）。
- **执行稳定**：`RouterRuntime.execute()` 在 fake provider / fake judge 下产出可断言的 CanonicalModelEvent 序列、fallback 顺序、retry 次数和 stats 记录。
- **行为一致**：与旧 CCR 在 `must_match` 场景上产出相同的可观察行为（决策、改写、事件顺序、错误归一化）。
- **隔离干净**：所有测试默认不读真实 `~/.politdeck`、`~/.claude/projects/`、`~/.edgeclaw`、不调用真实 LLM、不监听端口。

“行为一致”不要求逐字节复制旧 UI 文案或日志，只要求外部可观察行为相同：

- 同样的请求输入是否走相同的 scenarioType。
- 同样的 longContext 阈值是否切到 longContext model。
- 同样的 subagent 输入是否被识别为子代理。
- 同样的 judge 输出是否解析到相同 tier。
- 同样的 orchestrate 触发条件是否注入相同长度的 user system-reminder（允许文案差异，但 tier 标签一致）。
- 同样的 fallback 链在相同上游错误下尝试相同顺序。
- 同样的 zero-usage 场景重试相同次数后失败。

## 2. 测试目录

测试维护在 `/Users/gucc1/Codes/work/modelbest/PolitDeck/tests/router/`：

```text
tests/
  router/
    config/
      parse-router-config.test.ts
      resolve-provider-ref.test.ts
      hot-reload-classify.test.ts
    scenario/
      decide-scenario.test.ts
      long-context-threshold.test.ts
      subagent-detector.test.ts
    token-saver/
      generate-judge-prompt.test.ts
      parse-tier.test.ts
      classify-and-route.test.ts
      subagent-policy.test.ts
    orchestrate/
      apply-orchestration.test.ts
      slim-system-prompt.test.ts
      rewrite-async-agent-launched.test.ts
      load-orchestrate-prompt.test.ts
    session/
      session-router-store.test.ts
      session-usage-cache.test.ts
    fallback/
      run-fallback-chain.test.ts
    retry/
      zero-usage-retry-stream.test.ts
      zero-usage-retry-nonstream.test.ts
    runtime/
      router-runtime-decide.test.ts
      router-runtime-execute.test.ts
      events.test.ts
    custom-router/
      load-custom-router.test.ts
    stats/
      token-stats-collector.test.ts
      pricing.test.ts
    parity/
      manifest.test.ts
      parity-decide.test.ts
      parity-execute.test.ts
      parity-token-saver.test.ts
      parity-orchestrate.test.ts
      parity-fallback.test.ts
      parity-zero-usage.test.ts
    e2e/
      real-judge.test.ts             # default skipped, opt-in via POLITDECK_RUN_REAL_ROUTER_E2E=1
    helpers/
      createRouterRuntime.ts
      createFakeModelTransport.ts
      createFakeJudgeTransport.ts
      buildFixtureRequest.ts
      assertRouterDecision.ts
      legacyHarness.ts               # 启动旧 CCR runtime 的薄壳
    fixtures/
      router/
        configs/                     # PolitConfig fixture
        requests/                    # CanonicalModelRequest 输入
        legacy-config/               # 把 PolitConfig 翻译成 ~/.claude-code-router/config.json
        sse-replays/                 # 抓包的流式响应
        decisions/                   # parity scenarios
        orchestrate-skills/
```

当前根项目测试以 `package.json` 为准：`npm test` 会先 build，再用 Node test runner 执行 `dist/tests/**/*.test.js`。旧 CCR / legacy harness 如需要 Bun，只能在对应 parity probe 内局部使用。

## 3. 测试命名

所有新 helper、fixture、事件、错误码必须使用 PolitDeck 命名。允许出现旧项目名称的位置：

- 源码路径引用，例如 `third-party/claude-code-main/src/router/src/utils/router.ts`。
- 旧行为基线说明。
- fixture 文件夹名称中的 `legacy-config`、`legacy-runtime`，表示“给旧实现读的输入”。

禁止：

- 新类型 / 新事件 / 新配置 key 使用 `ccr_` / `claude_` / `tengu_` 前缀。
- 新 helper 命名为 `createCCRRuntime` / `runClaudeRouter`。

推荐 helper 命名：

```ts
createPolitDeckRouterRuntime()
createPolitDeckFakeModelTransport()
createPolitDeckFakeJudgeTransport()
createPolitDeckRouterFixtureRequest()
assertPolitDeckRouterDecision()
runPolitDeckRouterParityScenario()
```

## 4. 测试分层

router 测试按下层 → 上层组织。每一层都对上一层做 mock，不让上层测试承担下层断言。

```text
config tests
  -> protocol tests
  -> scenario tests
  -> subagent tests
  -> token-saver tests
  -> orchestrate tests
  -> session-state tests
  -> fallback / retry tests
  -> runtime tests (decide + execute)
  -> custom router tests
  -> stats tests
  -> parity tests (bilateral)
```

### 4.1 Config tests

验证 `parseRouterConfig()` 与 `polit/config` 的集成：

- scenarios.default 缺失报错。
- scenarios.default 引用不存在 provider 报错。
- fallback 链中 model 不存在报错。
- tokenSaver.judge 引用不存在 provider 报错。
- tokenSaver.tiers 为空时报错。
- subagent.policy 取值非法时报错。
- longContextThreshold 非正整数报错。
- 合法配置返回结构化 RouterConfig。
- redact：API key 不出现在 diagnostics / hash 中。
- 热重载分类（参见 `[02-rewrite-plan.md](./02-rewrite-plan.md)` §5）。

### 4.2 Protocol tests

验证 RouterDecision、RouterEvent、RouterError 的纯结构：

- RouterDecision 字段稳定（schema 固定）。
- mutations log 序列化稳定。
- RouterError 的 code 与 retryable 字段。

### 4.3 Scenario tests

驱动 `decideScenario()` 纯函数：

- 显式 `provider/model` 命中 default。
- `tokenCount > longContextThreshold` 命中 longContext。
- `lastUsage.input_tokens > longContextThreshold && tokenCount > 20000` 命中 longContext。
- `<CCR-SUBAGENT-MODEL>` tag 命中（注意：parity 用 `<politdeck-subagent-model>`，但需要保留对旧 tag 的兼容直到迁移完成）。
- `claude` + `haiku` 关键字命中 background。
- `tools[].type` 以 `web_search` 开头命中 webSearch。
- `req.body.thinking` 存在命中 think。
- 都不命中时回落 default。

### 4.4 Subagent tests

`detectAndCleanSubagentTag()`：

- 通过 `<CCR-SUBAGENT-MODEL>` tag 识别。
- 通过缺少 `Agent` tool 识别。
- 兼容工具列表为空、tools 为 undefined。
- 检测后 system tag 必须被清掉，避免下游再触发。

### 4.5 Token Saver tests

- `generateJudgePrompt(tiers, rules)` 输出稳定字符串（snapshot）。
- `parseTier(response, validTiers, defaultTier)`：
  - 正常 JSON。
  - 含 `<think>...</think>` 包裹。
  - 非法 JSON 回落 defaultTier。
  - tier 大小写归一化。
- `classifyAndRoute()`：
  - 注入 fake `judgeRuntime`，断言入参是预期 prompt。
  - judge 返回正常 tier → 命中。
  - judge 超时 → fallback defaultTier。
  - judge 抛错 → fallback defaultTier，发射 `politdeck_router_token_saver_failed`。
- subagent policy（skip / judge / inherit / fixed）四种行为：
  - skip：使用 default model，scenarioType=tokenSaver，但不调 judge。
  - judge：在 `${sessionId}:sub` 里独立 sticky。
  - inherit：复用 `${sessionId}` 的 sticky tier。
  - fixed：使用 `subagentModel`。

### 4.6 Orchestrate tests

- 当 `scenarioType=tokenSaver` 且 `tokenSaverTier ∈ triggerTiers` 时进入 orchestrate。
- 主代理：
  - 注入 user system-reminder（断言起始 message role / 关键标记 / tier 占位）。
  - 裁剪 blockedTools 前缀的工具，统计 mutations.toolsStripped。
  - slimSystemPrompt：第一个 block 保留 cache_control，包含 memory keyword 的 block 保留。
  - mainAgentModel 覆盖。
- 子代理：
  - 不注入 prompt、不裁剪工具、不 slim system。
  - tokenSaver 决定的 tier model 直接生效。
- 非 Claude orchestrator：
  - 把 `tool_result` 里的 `Async agent launched` 文案替换为 PolitDeck 等价指令。

### 4.7 Session State tests

- LRU 上限（500）。
- TTL（3600s）使用 fake clock。
- `${sessionId}` 与 `${sessionId}:sub` 互不干扰。
- `setOrchestrating(sessionId, true)` 后再 `updateSessionState()`，orchestrating flag 保留。

### 4.8 Fallback / Retry tests

- fallback 链按配置顺序尝试，跳过 provider 不存在或 transformer 失败的项。
- fallback 命中时 `RouterDecision.resolvedFrom='fallback'`。
- fallback 不重新跑 orchestrate（mutations 保持 first decision 的）。
- zero-usage retry 流式：
  - 首次响应 200 但 usage prompt=0 / completion=0 / hasContent=true → 重试。
  - 第 6 次仍然 zero-usage → 退出循环，使用最后一次响应（与旧实现一致）。
- zero-usage retry 非流式：
  - 直接对 JSON 做检测。

### 4.9 Runtime tests

`RouterRuntime.decide()` 与 `RouterRuntime.execute()` 端到端（fake judge + fake model transport）：

- decide：覆盖 §4.3 / §4.4 / §4.5 中的组合。
- execute：
  - text-only 流式响应。
  - tool-call 流式响应。
  - provider 5xx → fallback。
  - provider 401 → 不 fallback，直接错误。
  - decide() 返回的 decision 与 execute() 期间事件序列匹配。
  - 多次 decide() 在同 session 上 sticky 命中（第二次跳过 judge）。

### 4.10 Custom Router tests

- 注册一个 fake extension 返回固定 RouterDecision，断言 internal scenario 被绕过。
- custom router 抛错时回落内置策略。
- custom router 返回 invalid model 时记录 diagnostic 并回落内置策略。

### 4.11 Stats tests

- 单事件聚合到 session / hourly / global。
- pricing 应用后 cost 字段计算正确。
- reset 后所有桶清零。
- 写盘路径在 `${PolitCacheDir}/router/stats/`。

## 5. Fake 依赖

router 测试所有外部依赖都通过 fake 替换。

### 5.1 Fake model transport

`src/model/streaming/streamModel.ts` 已经支持 `options.fetch` 注入。helper：

```ts
export function createPolitDeckFakeModelTransport(
  fixtures: Map<string, FakeProviderResponse>
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const fixture = fixtures.get(url);
    if (!fixture) throw new Error(`No fake provider fixture for ${url}`);
    return fixture.toResponse();
  };
}
```

`FakeProviderResponse` 支持：

- 200 + 完整 SSE 序列。
- 200 + 单个 JSON。
- 200 + zero-usage（`prompt_tokens=0, completion_tokens=0, content="x"`）。
- 4xx / 5xx + JSON error body。
- 网络抛错（`throw new TypeError("Network error")`）。

### 5.2 Fake judge runtime

```ts
export function createPolitDeckFakeJudgeTransport(
  responses: Array<{ tier: string; raw?: string }>
): typeof fetch {
  let cursor = 0;
  return async () => {
    const next = responses[cursor++];
    return new Response(JSON.stringify({
      choices: [{ message: { content: next.raw ?? `{"tier":"${next.tier}"}` }}],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  };
}
```

测试可以通过传入 `cursor` 检查 judge 被调用了几次（验证 sticky）。

### 5.3 Fake clock & uuid

```ts
const clock = new PolitDeckFakeClock("2026-01-01T00:00:00Z");
const runtime = createPolitDeckRouterRuntime({ now: clock.now, uuid: clock.uuid });
clock.advance(3_700_000); // 让 sticky TTL 过期
```

### 5.4 Fake extension runtime

```ts
const extension = createPolitDeckFakeExtensionRuntime({
  customRouter: async (input) => ({ provider: "deepseek", model: "deepseek-chat" }),
  loadSkill: async (id) => "Custom orchestrator skill body",
});
```

## 6. 双边 Parity 测试

双边 parity 测试是新旧实现对比的核心，目的是在不让旧源码成为新项目运行时依赖的前提下，证明两边在相同输入下行为一致。

### 6.1 总体架构

```text
parity scenario fixture (PolitConfig + Request + Expected events)
  -> PolitDeck side:
       parsePolitConfig() -> RouterRuntime.decide() / execute()
       --> normalize result to ParityObservation
  -> Legacy side (only when scenario.parity === 'must_match' or 'compare'):
       translatePolitConfigToLegacyConfig()
         -> 旧 router(req, _, ctx)            (decide 等价)
         -> 旧 pipeline.processRequest(...)   (execute 等价)
       --> normalize result to ParityObservation
  -> assertEqualParityObservation(politdeck, legacy)
```

旧实现以**测试用 harness** 形式存在，仅在 parity 测试中被加载，不进入 production bundle。harness 路径：

```ts
import { createLegacyCcrRuntime } from "../helpers/legacyHarness.js";
```

`legacyHarness.ts` 内部：

- 通过 dynamic import 直接加载旧项目的两个纯函数，**不**实例化旧 Fastify `Server`、**不**调用 `Server.app.inject()`、**不**监听端口：
  - `import("../../../third-party/claude-code-main/src/router/src/utils/router")` → 旧 `router(req, _, ctx)`，对应 PolitDeck 的 `decide()`。
  - `import("../../../third-party/claude-code-main/src/router/src/pipeline")` → 旧 `processRequest(url, init, services, realFetch)`，对应 PolitDeck 的 `execute()`。
- 用 fixture 中的 `legacy-config` 直接构造旧 `ConfigService` / `ProviderService` / `TransformerService` / `TokenizerService` 实例（不经过 `Server.init()` 的 fastify 注入）。
- 把 PolitDeck 端使用的同一份 `FakeProviderResponse` map 通过 `processRequest()` 的 `realFetch` 参数显式传入旧 pipeline；不再调用 `installFetchInterceptor()`，不修改 `globalThis.fetch`。
- 提供 `runLegacyDecision(request)` 与 `runLegacyExecution(request)` 两个入口，分别用于 decide 与 execute 双边对比。
- 这意味着旧实现中的 fastify `Server` 类、`registerNamespace`、`addHook`、HTTP 路由 / API routes / middleware 在 parity 测试中**完全不被加载**，与 02-rewrite-plan.md §3「不迁移」清单保持一致。

### 6.2 ParityObservation 协议

```ts
export type PolitDeckRouterParityObservation = {
  decision: {
    provider: string;
    model: string;
    scenarioType: "default" | "background" | "think" | "longContext" | "webSearch" | "tokenSaver";
    tokenSaverTier?: string;
    isSubagent: boolean;
    orchestrating: boolean;
  };
  mutations: {
    systemPromptSlimmed?: { fromBlocks: number; toBlocks: number; preservedKeywords: string[] };
    toolsStripped?: { before: number; after: number; removedNames: string[] };
    orchestrationPromptInjected?: { tier: string; chars: number; messagesPrependedRole: "user" };
    asyncAgentLaunchedRewritten?: boolean;
    subagentTagStripped?: boolean;
  };
  execution: {
    targetUrl: string;
    requestBodyShape: ParityRequestBodyShape;        // 只对比关键字段，不对比逐字 SHA
    fallbackChain: Array<{ provider: string; model: string; status: number }>;
    zeroUsageRetries: number;
    eventTypes: string[];                            // CanonicalModelEvent.type 序列
    finishReason?: string;
    usage?: { input?: number; output?: number; cacheRead?: number };
  };
  errors?: {
    code: string;
    retryable: boolean;
  };
};
```

`ParityRequestBodyShape` 的对比规则：

- 比较 `system` block 数量、关键 marker 是否存在（`<system-reminder>` 内容、orchestrator tier 标签）。
- 比较 `messages` 长度、首尾 role / 关键 marker。
- 比较 `tools` 名字集合。
- 不比较 nonce / timestamp / uuid。

### 6.3 ParityScenario manifest

类似 agent 模块的 `executionScenarios.ts`，router 维护一个清单：

```ts
// tests/fixtures/router/decisions/parityScenarios.ts
export type PolitDeckRouterParityStatus =
  | "must_match"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type PolitDeckRouterParityScenario = {
  id: string;
  status: PolitDeckRouterParityStatus;
  feature: string;
  configFixture: string;
  requestFixture: string;
  expected?: Partial<PolitDeckRouterParityObservation>;
  intentionalDifferenceReason?: string;
  deferredUntil?: string;
};

export const routerParityScenarios: PolitDeckRouterParityScenario[] = [
  // ── decide() ──
  { id: "router-decide-default-model", status: "must_match", feature: "explicit provider/model bypasses scenario", configFixture: "configs/basic.yaml", requestFixture: "requests/explicit-provider.json" },
  { id: "router-decide-long-context-by-token-count", status: "must_match", feature: "tokenCount > longContextThreshold routes to longContext", configFixture: "configs/long-context.yaml", requestFixture: "requests/long-context-prompt.json" },
  { id: "router-decide-long-context-by-last-usage", status: "must_match", feature: "lastUsage.input_tokens triggers longContext", configFixture: "configs/long-context.yaml", requestFixture: "requests/long-context-followup.json" },
  { id: "router-decide-think", status: "must_match", feature: "thinking field selects Router.think", configFixture: "configs/basic.yaml", requestFixture: "requests/thinking.json" },
  { id: "router-decide-haiku-background", status: "must_match", feature: "claude+haiku falls into background scenario", configFixture: "configs/basic.yaml", requestFixture: "requests/haiku.json" },
  { id: "router-decide-web-search", status: "must_match", feature: "web_search tool falls into webSearch", configFixture: "configs/basic.yaml", requestFixture: "requests/web-search.json" },
  { id: "router-decide-subagent-by-tag", status: "must_match", feature: "<SUBAGENT-MODEL> tag detected", configFixture: "configs/basic.yaml", requestFixture: "requests/subagent-tag.json" },
  { id: "router-decide-subagent-by-missing-agent-tool", status: "must_match", feature: "missing Agent tool detected as subagent", configFixture: "configs/basic.yaml", requestFixture: "requests/subagent-no-agent-tool.json" },

  // ── tokenSaver ──
  { id: "router-token-saver-simple", status: "must_match", feature: "judge returns SIMPLE -> tier model used", configFixture: "configs/token-saver.yaml", requestFixture: "requests/short-question.json" },
  { id: "router-token-saver-complex", status: "must_match", feature: "judge returns COMPLEX -> tier model used", configFixture: "configs/token-saver.yaml", requestFixture: "requests/refactor.json" },
  { id: "router-token-saver-judge-failed-fallback", status: "must_match", feature: "judge fails -> defaultTier", configFixture: "configs/token-saver.yaml", requestFixture: "requests/short-question.json" },
  { id: "router-token-saver-sticky", status: "must_match", feature: "second turn in same session reuses sticky tier", configFixture: "configs/token-saver.yaml", requestFixture: "requests/sticky-followup.json" },
  { id: "router-token-saver-subagent-skip", status: "must_match", feature: "subagent policy=skip uses default model", configFixture: "configs/token-saver-subagent-skip.yaml", requestFixture: "requests/subagent-no-agent-tool.json" },
  { id: "router-token-saver-subagent-judge", status: "must_match", feature: "subagent policy=judge stores sub sticky", configFixture: "configs/token-saver-subagent-judge.yaml", requestFixture: "requests/subagent-no-agent-tool.json" },
  { id: "router-token-saver-subagent-inherit", status: "must_match", feature: "subagent policy=inherit reuses parent sticky", configFixture: "configs/token-saver-subagent-inherit.yaml", requestFixture: "requests/subagent-no-agent-tool.json" },
  { id: "router-token-saver-subagent-fixed", status: "must_match", feature: "subagent policy=fixed uses subagentModel", configFixture: "configs/token-saver-subagent-fixed.yaml", requestFixture: "requests/subagent-no-agent-tool.json" },

  // ── orchestrate ──
  { id: "router-orchestrate-main-agent", status: "must_match", feature: "main agent: prompt injection + tool stripping + slim system", configFixture: "configs/orchestrate.yaml", requestFixture: "requests/complex-task.json" },
  { id: "router-orchestrate-subagent-not-affected", status: "must_match", feature: "subagent in orchestrating session uses tier model", configFixture: "configs/orchestrate.yaml", requestFixture: "requests/orchestrating-subagent.json" },
  { id: "router-orchestrate-non-claude-async-rewrite", status: "must_match", feature: "non-claude orchestrator rewrites Async-agent-launched", configFixture: "configs/orchestrate-gpt5.yaml", requestFixture: "requests/orchestrator-tool-result.json" },

  // ── execute ──
  { id: "router-execute-text-stream", status: "must_match", feature: "text-only stream surfaces canonical events", configFixture: "configs/basic.yaml", requestFixture: "requests/short-question.json" },
  { id: "router-execute-tool-call-stream", status: "must_match", feature: "tool_use stream surfaces tool_call_* events", configFixture: "configs/basic.yaml", requestFixture: "requests/tool-call.json" },
  { id: "router-execute-fallback-on-5xx", status: "must_match", feature: "5xx triggers fallback chain", configFixture: "configs/fallback.yaml", requestFixture: "requests/short-question.json" },
  { id: "router-execute-zero-usage-retry-stream", status: "must_match", feature: "zero-usage stream retried", configFixture: "configs/basic.yaml", requestFixture: "requests/short-question.json" },
  { id: "router-execute-zero-usage-retry-nonstream", status: "must_match", feature: "zero-usage non-stream retried", configFixture: "configs/basic.yaml", requestFixture: "requests/short-question-non-stream.json" },

  // ── intentional differences ──
  { id: "router-mutation-naming", status: "intentional_difference", feature: "mutation event names use politdeck_ prefix", configFixture: "configs/basic.yaml", requestFixture: "requests/short-question.json", intentionalDifferenceReason: "PolitDeck rebrands events; only cardinality / order is compared." },
  { id: "router-config-source", status: "intentional_difference", feature: "config sourced from politdeck.yaml not ~/.claude-code-router/config.json", configFixture: "configs/basic.yaml", requestFixture: "requests/short-question.json", intentionalDifferenceReason: "PolitDeck redirects config to PolitHome; legacy bridge converts in fixture." },

  // ── deferred ──
  { id: "router-preset-marketplace", status: "deferred", feature: "remote preset marketplace install/export", configFixture: "configs/preset-noop.yaml", requestFixture: "requests/short-question.json", deferredUntil: "After preset subsystem migration." },
  { id: "router-vertex-gemini", status: "deferred", feature: "Vertex Gemini transformer parity", configFixture: "configs/vertex.yaml", requestFixture: "requests/short-question.json", deferredUntil: "After Vertex protocol adapter." },
];
```

`tests/router/parity/manifest.test.ts` 像 `tests/agent/parity-dual-execution.test.ts` 一样校验 manifest：

- 所有 id 唯一。
- `must_match` 必须有 expected。
- `intentional_difference` 必须有 reason。
- `deferred` 必须有 deferredUntil。
- 关键 id（`router-execute-fallback-on-5xx` 等）必须 status=must_match。

### 6.4 双边执行流程

`tests/router/parity/parity-decide.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { routerParityScenarios } from "../../fixtures/router/decisions/parityScenarios.js";
import { runPolitDeckParityDecision } from "../helpers/createRouterRuntime.js";
import { runLegacyParityDecision } from "../helpers/legacyHarness.js";

for (const scenario of routerParityScenarios.filter((s) => s.status === "must_match")) {
  test(`router parity decide ${scenario.id}`, async () => {
    const polit = await runPolitDeckParityDecision(scenario);
    const legacy = await runLegacyParityDecision(scenario);
    assertEqualParityObservation(polit, legacy);
    if (scenario.expected) {
      assertObservationContains(polit, scenario.expected);
    }
  });
}
```

`assertEqualParityObservation()` 比较 `ParityObservation.decision` 与 `mutations` 字段，忽略事件命名差异（旧 `tengu_*` ↔ 新 `politdeck_router_*`）。

`tests/router/parity/parity-execute.test.ts` 比较 `ParityObservation.execution`：targetUrl、fallbackChain 顺序、zeroUsageRetries、eventTypes 序列。

`tests/router/parity/parity-token-saver.test.ts` 与 `parity-orchestrate.test.ts` 共享同一组 fixture，但断言粒度更细（mutations 字段 + judge 调用次数）。

### 6.5 共享 fixture

为避免新旧实现读两套 fixture，`tests/fixtures/router/configs/*.yaml` 是 PolitDeck 形态（`provider/model`、`router.scenarios.*`）；通过 helper 转译给旧实现：

```ts
// tests/router/helpers/legacyHarness.ts
function translatePolitConfigToLegacyConfig(politConfig: PolitConfig): LegacyCcrConfig {
  return {
    Providers: politConfig.model.providers ...,
    Router: {
      default: legacyJoin(politConfig.router.scenarios.default),
      background: legacyJoin(politConfig.router.scenarios.background),
      think: legacyJoin(politConfig.router.scenarios.think),
      longContext: legacyJoin(politConfig.router.scenarios.longContext),
      longContextThreshold: politConfig.router.scenarios.longContextThreshold,
      webSearch: legacyJoin(politConfig.router.scenarios.webSearch),
      tokenSaver: politConfig.router.tokenSaver ? translateTokenSaver(...) : undefined,
      autoOrchestrate: politConfig.router.autoOrchestrate ? translateAutoOrchestrate(...) : undefined,
    },
    fallback: politConfig.router.fallback ?? undefined,
  };
}
```

`legacyJoin()` 把 `{ provider: "openrouter", model: "anthropic/claude-sonnet-4-5" }` 转成 `"openrouter,anthropic/claude-sonnet-4-5"`。

### 6.6 双边 fake provider

PolitDeck 端通过 `RouterRuntimeDeps.modelRuntime` 内部的 `options.fetch` 注入 fake provider；旧端通过 `pipeline.processRequest()` 的 `realFetch` 形参直接传入同一个 fake fetch。两边读取**同一份** `FakeProviderResponse` map（按 URL 匹配），全程不修改 `globalThis.fetch`：

```ts
const provider = new InMemoryFakeProviderRegistry();
provider.set("https://openrouter.ai/api/v1/chat/completions", { ...fixture-1 });
provider.set("https://api.deepseek.com/v1/chat/completions",   { ...fixture-2 });

const politdeckRuntime = createPolitDeckRouterRuntime({ ..., fetch: provider.toFetch() });
const legacyHarness  = await createLegacyCcrRuntime({ ..., fetch: provider.toFetch() });
```

这样可以保证：

- 同一个上游 URL 在新旧实现下都返回相同 SSE 字节流。
- 同一个 zero-usage fixture 在两边都触发完全相同次数的重试。
- parity 测试不会因为修改 `globalThis.fetch` 互相串扰，可以并发跑。

### 6.7 命名差异容忍清单

旧实现里有些字段已经是 `tier`、`scenarioType`、`isSubagent`，命名兼容。但下面差异是 intentional：

| 旧 | 新 | 处理 |
| --- | --- | --- |
| `req.body.model = "openrouter,anthropic/claude-sonnet-4-5"` | `decision.provider = "openrouter"` + `decision.model = "anthropic/claude-sonnet-4-5"` | parity normalizer 会把旧 body.model 拆开比较。 |
| `politdeck.yaml` 路径 | `~/.claude-code-router/config.json` | fixture 一份，translator 双向转。 |
| `<CCR-SUBAGENT-MODEL>` | `<politdeck-subagent-model>` | parity 要求两种 tag 都被识别，但默认 fixture 用旧 tag，避免改动旧实现。 |
| `tengu_*` / `_zRetry` 内部变量 | `politdeck_router_*` 事件、`zeroUsageRetries` 计数 | parity normalizer 把旧内部行为映射成新事件序列（基于事件计数 / 顺序判定）。 |
| `CCR_DEBUG_DUMP` | `POLITDECK_ROUTER_DEBUG_DUMP` | parity 测试不开任何 debug dump。 |

## 7. 核心用例

下面给出几个最关键的测试用例（均覆盖在 §6 manifest 中），写法对所有同类用例适用。

### 7.1 用例 A：长上下文路由

输入：

- PolitConfig 中 `router.scenarios.longContextThreshold = 60000`，`router.scenarios.longContext = openrouter/google-gemini-2-5-pro`。
- 请求 messages 经 tokenizer 计算 tokenCount=70000。
- 无 lastUsage。

断言：

- `RouterDecision.scenarioType === 'longContext'`。
- `RouterDecision.provider === 'openrouter'`。
- `RouterDecision.model === 'google/gemini-2-5-pro'`。
- 旧实现命中相同 model（旧 body.model 为 `"openrouter,google/gemini-2-5-pro"`）。

### 7.2 用例 B：lastUsage 触发长上下文

输入：

- 请求 messages 经 tokenizer 计算 tokenCount=25000。
- `sessionUsageCache.get(sessionId).input_tokens = 80000`。
- threshold = 60000。

断言：

- `tokenCount > 20000` 且 `lastUsage.input_tokens > threshold` → longContext。
- 第二个 token 数小于 20000 的请求不会触发 longContext。

### 7.3 用例 C：subagent policy = inherit

输入：

- 配置 `router.tokenSaver.subagent.policy = "inherit"`。
- session 上一次 judge 结果存到 `sessionId`，tier = COMPLEX，model = openrouter/anthropic-claude-opus-4。
- 当前请求工具列表无 `Agent` tool（被识别为 sub-agent）。

断言：

- `RouterDecision.tokenSaverTier === 'COMPLEX'`。
- `RouterDecision.model === 'anthropic/claude-opus-4'`。
- judge runtime 调用次数为 0（继承不调用 judge）。
- 旧实现也命中同 tier 与同 model。

### 7.4 用例 D：AutoOrchestrate 主代理

输入：

- 配置 `router.autoOrchestrate.enabled = true`、`triggerTiers = [COMPLEX]`。
- judge 返回 COMPLEX。
- request.tools 含 `Agent`（主代理）+ `WebSearch` + `mcp__browser-use__open_url`。
- request.system 为 8 个 block，其中两个 block 含 `ClawXMemory` 关键字。

断言：

- `decision.orchestrating === true`。
- `mutations.toolsStripped.before === 3`、`toolsStripped.after === 1`（只剩 Agent）。
- `mutations.systemPromptSlimmed.fromBlocks === 8`、`toBlocks === 3`（slim block + 2 个保留）。
- `mutations.orchestrationPromptInjected.tier === 'COMPLEX'`、`messages[0].role === 'user'`。
- 旧实现 mutation 计数与 PolitDeck 一致（即使日志文案不同）。

### 7.5 用例 E：Fallback 链

输入：

- 配置 `router.fallback.default = [deepseek/deepseek-chat, openrouter/anthropic-claude-sonnet-4-5]`。
- 主请求 fake provider 返回 503。
- fallback[0] fake provider 返回 200 + 完整流。

断言：

- `execution.fallbackChain.length === 2`（包含主 + fallback[0]）。
- `execution.fallbackChain[0].status === 503`、`fallbackChain[1].status === 200`。
- `eventTypes` 包含 `text_delta`、`message_end`、`usage`。
- `decision.resolvedFrom === 'fallback'` 且 `decision.model === 'deepseek-chat'`。
- 旧实现尝试相同顺序，最终成功。

### 7.6 用例 F：Zero-Usage Retry 流式

输入：

- 主 provider 第一次返回 200 + SSE，prompt_tokens=0、completion_tokens=0、有 content。
- 第二次返回 200 + SSE，prompt_tokens=120、completion_tokens=80、有 content。
- maxAttempts=5。

断言：

- `execution.zeroUsageRetries === 1`。
- 最终事件序列含完整 `text_delta` 序列与 `usage`（来自第二次）。
- 旧实现重试次数同样为 1。

### 7.7 用例 G：Judge 失败 fallback defaultTier

输入：

- judge runtime 抛 timeout。
- defaultTier = SIMPLE，对应 model deepseek/deepseek-chat。

断言：

- `decision.tokenSaverTier === 'SIMPLE'`。
- `decision.model === 'deepseek-chat'`。
- 发射 `politdeck_router_token_saver_failed` 事件，原因 = `judge_timeout`。
- 不影响后续请求送出。

## 8. 真实 Provider e2e（可选）

`tests/router/e2e/real-judge.test.ts` 默认跳过：

```ts
import test from "node:test";

test.skip(process.env.POLITDECK_RUN_REAL_ROUTER_E2E !== "1", "real router e2e disabled");
```

启用条件：

- `POLITDECK_RUN_REAL_ROUTER_E2E=1`
- `${PolitHome}/politdeck.yaml` 中存在合法 provider + judge 配置。

只验证 judge 能返回合法 tier，不验证主路由稳定性（避免 flakiness）。

## 9. 禁止事项

router 测试不应：

- 依赖真实 OAuth、Gemini API、OpenAI API 默认 quota。
- 依赖真实用户主目录下的 `~/.politdeck`、`~/.claude`、`~/.edgeclaw`、`~/.claude-code-router`。
- 在测试中监听任何 TCP 端口；新项目 router 没有 HTTP 形态，旧实现也通过 `router()` / `pipeline.processRequest()` 直接调用，不需要起 fastify 实例。
- 修改 `globalThis.fetch`；fake provider 必须通过显式参数注入。
- 引入旧项目源码作为 production runtime 依赖（`legacyHarness` 仅在 parity 测试 import 一次）。
- 把旧实现的内部缓存当成黑盒断言（必须通过对外可观察行为判等）。

router 测试不应跨模块断言：

- 不断言具体 transformer 输出字段（这是 model 模块测试的职责）。
- 不断言 tool execution 结果（tool 模块测试职责）。
- 不断言 transcript 文件结构（session 模块测试职责）。

## 10. CI 集成

- `npm test` 默认覆盖 `tests/router/` 编译后的 Node 测试。
- router parity 用例在 PR 中必跑；如果有 must_match 用例失败必须阻断合并。
- router e2e 仅在显式开启 `POLITDECK_RUN_REAL_ROUTER_E2E=1` 的 nightly 任务跑。
- parity manifest 变化必须在 PR 描述中给出：

```text
Router parity scope:
- decide
- execute
- tokenSaver
- orchestrate
- fallback / zero-usage

Must-match scenarios:
- total: 22
- passing: 22

Intentional differences:
- mutation/event naming (politdeck_router_*)
- config source (PolitConfig vs ~/.claude-code-router/config.json)

Deferred:
- preset marketplace
- vertex gemini transformer parity
```

## 11. 与已有 parity 框架的关系

router 模块的 parity 框架与 `tests/agent/parity-dual-*.test.ts`、`tests/tool/parity-*.test.ts` 共享下列约定：

- manifest 文件名以 `parityScenarios.ts` 结尾。
- scenario `status` 取值统一：`must_match` / `intentional_difference` / `deferred` / `not_applicable`。
- helper 命名以 `runPolitDeck...` 开头。
- 旧源码只能在 `tests/.../helpers/legacyHarness.ts` 中通过 dynamic import 加载，且不出现在 `src/` 任何文件的 import 链上。

router 自身额外增加：

- `ParityRequestBodyShape`：因为 router 会改写请求体，本层需要细粒度对比 mutations 而不是逐字节比较。
- `runPolitDeckParityDecision` 与 `runLegacyParityDecision`：分别封装 `decide()` 的双边执行。
- `runPolitDeckParityExecution` 与 `runLegacyParityExecution`：分别封装 `execute()` 的双边执行（含 fallback / zero-usage retry）。

通过这些约定，router 测试既能独立维护，也能在 agent 模块 parity 中作为子集被调用。
