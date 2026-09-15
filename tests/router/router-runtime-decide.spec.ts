import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
  MultimodalConstraints,
} from "../../src/model/index.js";
import type { CustomRouterRegistry } from "../../src/router/customRouter/customRouter.js";
import type { RouterConfig, RouterModelRef } from "../../src/router/config/schema.js";
import { createRouterRuntime, type RouterEvent } from "../../src/router/index.js";

/**
 * `RouterRuntime.decide()` 决策路径的特征化（characterisation）测试。
 *
 * 债务 #343：`decide()` 曾是 `createRouterRuntime` 闭包内的 224 行嵌套函数，
 * 捕获了十来个别名变量，因此 `tests/router/` 顶层只有 2 个 spec，决策分支
 * （粘性命中 / 判官分类 / cache-aware 切换 / 自定义路由 / 编排门控 / 媒体重路由）
 * 长期没有直接单测。这里只经由**公开入口** `createRouterRuntime(...).decide()`
 * 驱动，因此后续把 `decide` 抽成显式依赖的模块函数时，这些用例应逐条保持绿 ——
 * 它们就是这次重构的行为锚。
 */

const JUDGE: RouterModelRef = { id: "judge/judge-model", provider: "judge", model: "judge-model" };
const DEFAULT_REF: RouterModelRef = { id: "main/default-model", provider: "main", model: "default-model" };
const SIMPLE: RouterModelRef = { id: "main/simple-model", provider: "main", model: "simple-model" };
const COMPLEX: RouterModelRef = { id: "main/complex-model", provider: "main", model: "complex-model" };
const EXPENSIVE: RouterModelRef = { id: "main/expensive-model", provider: "main", model: "expensive-model" };
const CHEAP: RouterModelRef = { id: "main/cheap-model", provider: "main", model: "cheap-model" };
const VISION: RouterModelRef = { id: "main/vision-model", provider: "main", model: "vision-model" };

const TEXT_ONLY: MultimodalConstraints = { input: ["text"], images: false } as MultimodalConstraints;
const WITH_IMAGE: MultimodalConstraints = { input: ["text", "image"], images: true } as MultimodalConstraints;

/** 两轮以上的对话：`decide` 只在 `messages.length > 1` 时考虑会话粘性。 */
const twoTurnRequest: CanonicalModelRequest = {
  provider: "main",
  model: "default-model",
  messages: [
    { role: "user", content: [{ type: "text", text: "第一轮" }] },
    { role: "assistant", content: [{ type: "text", text: "好的" }] },
    { role: "user", content: [{ type: "text", text: "帮我分析这份权利要求" }] },
  ],
};

type RuntimeOptions = {
  /** 判官回复正文，默认分类到 complex。 */
  judgeText?: string;
  /** 每次 `complete` 的请求都会入账，用于断言「判官有没有被问」。 */
  judgeCalls?: CanonicalModelRequest[];
  /** 视为支持图片输入的 `provider/model`。 */
  imageModels?: string[];
  complete?: ModelRuntime["complete"];
};

function makeRuntime(options: RuntimeOptions = {}): ModelRuntime {
  const imageModels = new Set(options.imageModels ?? []);
  return {
    complete: async (request, opts) => {
      options.judgeCalls?.push(request);
      if (options.complete) {
        return options.complete(request, opts);
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: options.judgeText ?? "<tier>complex</tier>" }],
        finishReason: "stop",
      } as CanonicalModelResponse;
    },
    stream: () => {
      throw new Error("stream is not exercised in decide tests");
    },
    getCapabilities: () => ({ maxContextTokens: 100_000, maxOutputTokens: 4_096 }),
    getMultimodal: (provider: string, model: string) =>
      imageModels.has(`${provider}/${model}`) ? WITH_IMAGE : TEXT_ONLY,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
}

function baseConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: DEFAULT_REF },
    tokenSaver: {
      enabled: true,
      judge: JUDGE,
      defaultTier: "simple",
      tiers: { simple: { model: SIMPLE }, complex: { model: COMPLEX } },
      judgeTimeoutMs: 500,
    },
    ...overrides,
  };
}

function makeRuntimeHarness(
  config: RouterConfig,
  modelRuntime: ModelRuntime,
  extra: { customRouterRegistry?: CustomRouterRegistry } = {},
): { runtime: ReturnType<typeof createRouterRuntime>; events: RouterEvent[] } {
  const events: RouterEvent[] = [];
  const runtime = createRouterRuntime(config, {
    modelRuntime,
    now: () => new Date(0),
    events: { emit: event => events.push(event) },
    ...extra,
  });
  return { runtime, events };
}

test("router 关闭时决策直通请求里的 provider/model", async () => {
  const { runtime } = makeRuntimeHarness({ enabled: false }, makeRuntime());

  const decision = await runtime.decide({ request: twoTurnRequest, sessionId: "s-off", isMainAgent: true });

  assert.equal(decision.provider, "main");
  assert.equal(decision.model, "default-model");
  assert.equal(decision.scenarioType, "default");
  assert.equal(decision.isSubagent, false);
  assert.equal(decision.orchestrating, false);
  assert.equal(decision.resolvedFrom, "scenario");
  assert.equal(decision.tokenSaverTier, undefined);
  assert.deepEqual(decision.mutations, {});
});

test("判官分类结果决定 tier 与模型，并发出 sati_router_decision", async () => {
  const judgeCalls: CanonicalModelRequest[] = [];
  const modelRuntime = makeRuntime({ judgeText: "<tier>complex</tier>", judgeCalls });
  const { runtime, events } = makeRuntimeHarness(baseConfig(), modelRuntime);

  const decision = await runtime.decide({ request: twoTurnRequest, sessionId: "s-judge", isMainAgent: true });

  assert.equal(judgeCalls.length, 1, "判官应被问一次");
  assert.equal(decision.model, "complex-model");
  assert.equal(decision.tokenSaverTier, "complex");
  assert.equal(decision.resolvedFrom, "tokenSaver");

  const emitted = events.find(event => event.type === "sati_router_decision");
  assert.ok(emitted, `expected a decision event, got ${JSON.stringify(events)}`);
  assert.equal(emitted.decision.resolvedFrom, "tokenSaver");
  assert.equal(emitted.decision.model, "complex-model");
});

test("第二轮命中会话粘性，不再重复调用判官", async () => {
  const judgeCalls: CanonicalModelRequest[] = [];
  const modelRuntime = makeRuntime({ judgeText: "<tier>complex</tier>", judgeCalls });
  const { runtime } = makeRuntimeHarness(baseConfig(), modelRuntime);

  const first = await runtime.decide({ request: twoTurnRequest, sessionId: "s-sticky", isMainAgent: true });
  const second = await runtime.decide({ request: twoTurnRequest, sessionId: "s-sticky", isMainAgent: true });

  assert.equal(judgeCalls.length, 1, "第二轮应走粘性分支，判官只应被问一次");
  assert.equal(first.tokenSaverTier, "complex");
  assert.equal(second.tokenSaverTier, "complex");
  assert.equal(second.resolvedFrom, "tokenSaver");
  assert.equal(second.model, "complex-model");
});

test("显式 provider/model 跳过 tokenSaver 与判官", async () => {
  const judgeCalls: CanonicalModelRequest[] = [];
  const { runtime } = makeRuntimeHarness(baseConfig(), makeRuntime({ judgeCalls }));

  const decision = await runtime.decide({
    request: twoTurnRequest,
    sessionId: "s-explicit",
    isMainAgent: true,
    metadata: { explicitProvider: "main", explicitModel: "explicit-model" },
  });

  assert.equal(decision.scenarioType, "explicit");
  assert.equal(decision.resolvedFrom, "explicit");
  assert.equal(decision.model, "explicit-model");
  assert.equal(judgeCalls.length, 0, "显式指定不应惊动判官");
});

test("subagent policy=skip 时不咨询判官", async () => {
  const judgeCalls: CanonicalModelRequest[] = [];
  const config = baseConfig({
    tokenSaver: {
      enabled: true,
      judge: JUDGE,
      defaultTier: "simple",
      tiers: { simple: { model: SIMPLE }, complex: { model: COMPLEX } },
      judgeTimeoutMs: 500,
      subagent: { policy: "skip" },
    },
  });
  const { runtime } = makeRuntimeHarness(config, makeRuntime({ judgeCalls }));

  const decision = await runtime.decide({ request: twoTurnRequest, sessionId: "s-sub-skip", isMainAgent: false });

  assert.equal(judgeCalls.length, 0, "policy=skip 的子代理不应触发判官");
  assert.equal(decision.resolvedFrom, "scenario");
  assert.equal(decision.model, "default-model");
});

test("自定义路由胜出时标记 resolvedFrom=custom 且不问判官", async () => {
  const judgeCalls: CanonicalModelRequest[] = [];
  const registry: CustomRouterRegistry = {
    lookupRouter: extensionId =>
      extensionId === "ext-1"
        ? {
            id: "ext-1",
            decide: async () => ({ provider: "custom-provider", model: "custom-model" }),
          }
        : undefined,
  };
  const { runtime } = makeRuntimeHarness(
    baseConfig({ customRouter: { extensionId: "ext-1" } }),
    makeRuntime({ judgeCalls }),
    { customRouterRegistry: registry },
  );

  const decision = await runtime.decide({ request: twoTurnRequest, sessionId: "s-custom", isMainAgent: true });

  assert.equal(decision.provider, "custom-provider");
  assert.equal(decision.model, "custom-model");
  assert.equal(decision.resolvedFrom, "custom");
  assert.equal(judgeCalls.length, 0);
});

test("自定义路由抛错时落 sati_router_custom_failed 并回落到场景默认", async () => {
  const registry: CustomRouterRegistry = {
    lookupRouter: () => ({
      id: "ext-boom",
      decide: async () => {
        throw new Error("custom router exploded");
      },
    }),
  };
  const { runtime, events } = makeRuntimeHarness(
    baseConfig({ customRouter: { extensionId: "ext-boom" } }),
    makeRuntime(),
    { customRouterRegistry: registry },
  );

  const decision = await runtime.decide({ request: twoTurnRequest, sessionId: "s-custom-fail", isMainAgent: true });

  const failed = events.find(event => event.type === "sati_router_custom_failed");
  assert.ok(failed, `expected a custom-router failure event, got ${JSON.stringify(events)}`);
  assert.equal(failed.extensionId, "ext-boom");
  assert.equal(failed.reason, "custom router exploded");
  assert.equal(decision.resolvedFrom, "tokenSaver", "自定义路由失败后应继续走常规决策路径");
});

test("cache-aware：判官选中的更便宜模型足以抵掉重填成本时切换", async () => {
  const config = baseConfig({
    tokenSaver: {
      enabled: true,
      judge: JUDGE,
      defaultTier: "cheap",
      tiers: { cheap: { model: CHEAP } },
      judgeTimeoutMs: 500,
      cacheAwareSwitching: { enabled: true, minSavingsRatio: 0 },
    },
    stats: {
      enabled: false,
      modelPricing: {
        "main/expensive-model": { input: 15, cacheRead: 1.5 },
        "main/cheap-model": { input: 0.15, cacheRead: 0.075 },
      },
    },
  });
  const { runtime } = makeRuntimeHarness(config, makeRuntime({ judgeText: "<tier>cheap</tier>" }));
  // cache-aware 判定读的是**会话用量缓存**（上一轮 observeUsage 的产物），而不是
  // 调用方 metadata 里的 lastUsage 提示 —— 后者只喂判官提示词。
  runtime.observeUsage("s-cache-switch", { inputTokens: 1_000, cacheReadTokens: 900 });

  const decision = await runtime.decide({
    request: twoTurnRequest,
    sessionId: "s-cache-switch",
    isMainAgent: true,
    metadata: {
      previousProvider: EXPENSIVE.provider,
      previousModel: EXPENSIVE.model,
    },
  });

  assert.equal(decision.model, "cheap-model");
  assert.equal(decision.mutations.cacheAwareSwitch?.action, "switched");
  assert.equal(decision.mutations.cacheAwareSwitch?.from, "main/expensive-model");
  assert.equal(decision.mutations.cacheAwareSwitch?.to, "main/cheap-model");
});

test("cache-aware：省下的钱不够时不切换，保留原模型", async () => {
  const config = baseConfig({
    tokenSaver: {
      enabled: true,
      judge: JUDGE,
      defaultTier: "cheap",
      tiers: { cheap: { model: CHEAP } },
      judgeTimeoutMs: 500,
      cacheAwareSwitching: { enabled: true, minSavingsRatio: 0 },
    },
    stats: {
      enabled: false,
      modelPricing: {
        // cacheRead == input ⇒ 缓存读成本恰好等于重填成本，切换无收益。
        "main/expensive-model": { input: 1, cacheRead: 1 },
        "main/cheap-model": { input: 1, cacheRead: 1 },
      },
    },
  });
  const { runtime } = makeRuntimeHarness(config, makeRuntime({ judgeText: "<tier>cheap</tier>" }));
  runtime.observeUsage("s-cache-keep", { inputTokens: 1_000, cacheReadTokens: 500 });

  const decision = await runtime.decide({
    request: twoTurnRequest,
    sessionId: "s-cache-keep",
    isMainAgent: true,
    metadata: {
      previousProvider: EXPENSIVE.provider,
      previousModel: EXPENSIVE.model,
    },
  });

  assert.equal(decision.mutations.cacheAwareSwitch?.action, "kept_sticky");
  assert.equal(decision.model, "expensive-model", "切换无收益时应保留上一轮的模型");
});

test("既无默认场景也解析不出模型时抛错", async () => {
  const { runtime } = makeRuntimeHarness({ enabled: true }, makeRuntime());

  await assert.rejects(
    runtime.decide({ request: twoTurnRequest, sessionId: "s-nothing", isMainAgent: true }),
    /no default scenario/,
  );
});

test("编排门控：tier 命中 triggerTiers 时打开 orchestrating", async () => {
  const config = baseConfig({
    autoOrchestrate: {
      enabled: true,
      triggerTiers: ["complex"],
      slimSystemPrompt: false,
    },
  });
  const { runtime } = makeRuntimeHarness(config, makeRuntime({ judgeText: "<tier>complex</tier>" }));

  const decision = await runtime.decide({ request: twoTurnRequest, sessionId: "s-orch", isMainAgent: true });

  assert.equal(decision.tokenSaverTier, "complex");
  assert.equal(decision.orchestrating, true);
  assert.equal(decision.mutations.orchestrationActivated?.tier, "complex");
  assert.equal(decision.mutations.orchestrationActivated?.continued, false);
});

test("媒体重路由：默认模型不支持图片时改派 fallback.media 候选", async () => {
  const config: RouterConfig = {
    enabled: true,
    scenarios: { default: DEFAULT_REF },
    fallback: { media: [VISION] },
  };
  const { runtime } = makeRuntimeHarness(config, makeRuntime({ imageModels: [VISION.id] }));

  const decision = await runtime.decide({
    request: {
      provider: "main",
      model: "default-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看看这张附图" },
            { type: "image", source: "base64", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        },
      ],
    },
    sessionId: "s-media",
    isMainAgent: true,
  });

  assert.equal(decision.provider, "main");
  assert.equal(decision.model, "vision-model");
  assert.equal(decision.resolvedFrom, "fallback");
  assert.deepEqual(decision.mutations.mediaCapabilityRerouted, {
    required: ["image"],
    from: "main/default-model",
    to: VISION.id,
  });
});

test("materializeRequest 收敛 maxOutputTokens 到模型上限并剥离 subagent 标签", async () => {
  const { runtime } = makeRuntimeHarness({ enabled: true, scenarios: { default: DEFAULT_REF } }, makeRuntime());

  const materialized = runtime.materializeRequest(
    {
      provider: "main",
      model: "default-model",
      scenarioType: "subagent",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "scenario",
      mutations: { subagentTagStripped: true },
    },
    {
      provider: "main",
      model: "default-model",
      maxOutputTokens: 999_999,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "<sati-subagent-model>main/cheap-model</sati-subagent-model> 帮我总结" }],
        },
      ],
    },
  );

  assert.equal(materialized.provider, "main");
  assert.equal(materialized.model, "default-model");
  assert.equal(materialized.maxOutputTokens, 4_096, "超过模型上限时应收敛到上限");
  assert.equal(
    materialized.messages[0].content[0].type === "text" ? materialized.messages[0].content[0].text : undefined,
    // 剥离用的是 `trimEnd()`：只收尾不留前导空格，故此处保留前导空格。
    " 帮我总结",
    "subagent 标签应被剥离",
  );
});

test("invalidateSticky 清掉粘性但保留编排态与 tier", async () => {
  const config = baseConfig({
    autoOrchestrate: { enabled: true, triggerTiers: ["complex"], slimSystemPrompt: false },
  });
  const { runtime } = makeRuntimeHarness(config, makeRuntime({ judgeText: "<tier>complex</tier>" }));

  await runtime.decide({ request: twoTurnRequest, sessionId: "s-invalidate", isMainAgent: true });
  const cleared = runtime.invalidateSticky("s-invalidate");

  assert.equal(cleared.previousTier, "complex");
  assert.equal(cleared.previousProvider, "main");
  assert.equal(cleared.previousModel, "complex-model");
  assert.equal(cleared.orchestrating, true);

  // 编排态被保留 ⇒ 下一轮 tick 后仍是 complex tier（而不是被重新判成 simple）。
  const next = await runtime.decide({ request: twoTurnRequest, sessionId: "s-invalidate", isMainAgent: true });
  assert.equal(next.tokenSaverTier, "complex");
});

test("router 关闭时 invalidateSticky 返回最小结果", () => {
  const { runtime } = makeRuntimeHarness({ enabled: false }, makeRuntime());

  assert.deepEqual(runtime.invalidateSticky("s-off-invalidate"), { orchestrating: false });
});
