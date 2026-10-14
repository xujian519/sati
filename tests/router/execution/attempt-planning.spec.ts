import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalModelError,
  CanonicalModelRequest,
  ModelRuntime,
  MultimodalConstraints,
} from "../../../src/model/index.js";
import type { RouterConfig, RouterModelRef } from "../../../src/router/config/schema.js";
import {
  applyDecisionToRequest,
  classifyAttemptGate,
  planAttempt,
  planAttemptExecution,
  subagentBudgetError,
  type AttemptRetryBudget,
} from "../../../src/router/execution/attemptPlanning.js";
import type { AttemptOutcome } from "../../../src/router/execution/streamAttempt.js";
import type { RouterDecision } from "../../../src/router/protocol/decision.js";

/**
 * P2.6 外置的纯判定层直测（`attemptPlanning.ts`）。
 *
 * 拆分前这些判定与 emit / sleep / 落账交缠在 `executeRouterDecision` 的 273 行编排体里，
 * 只能经 `createRouterRuntime` 端到端驱动；现在它们是纯函数，真值表在此逐条钉死。
 * 端到端行为另由 `tests/router/router-runtime-execute.spec.ts` 与 A/B 语料守住。
 */

const CAPABLE: RouterModelRef = { id: "capable/model-a", provider: "capable", model: "model-a" };
const TEXT_ONLY: RouterModelRef = { id: "textonly/model-b", provider: "textonly", model: "model-b" };

const TEXT: MultimodalConstraints = { input: ["text"], images: false } as MultimodalConstraints;
const TEXT_AND_IMAGE: MultimodalConstraints = { input: ["text", "image"], images: true } as MultimodalConstraints;

function fakeRuntime(input: Record<string, InputModalities> = {}): ModelRuntime {
  return {
    stream: () => {
      throw new Error("stream is not exercised by planning tests");
    },
    complete: () => {
      throw new Error("complete is not exercised by planning tests");
    },
    getCapabilities: () => ({ maxContextTokens: 100_000, maxOutputTokens: 4096 }),
    getMultimodal: (provider: string) => input[provider] ?? TEXT,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
}

type InputModalities = MultimodalConstraints;

const IMAGE_REQUEST: CanonicalModelRequest = {
  provider: CAPABLE.provider,
  model: CAPABLE.model,
  maxOutputTokens: 1024,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "看看这张附图" },
        { type: "image", source: "base64", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    },
  ],
};

const TEXT_REQUEST: CanonicalModelRequest = {
  provider: CAPABLE.provider,
  model: CAPABLE.model,
  maxOutputTokens: 1024,
  messages: [{ role: "user", content: [{ type: "text", text: "帮我分析这份权利要求" }] }],
};

function decision(ref: RouterModelRef, overrides: Partial<RouterDecision> = {}): RouterDecision {
  return {
    provider: ref.provider,
    model: ref.model,
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
    ...overrides,
  };
}

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return { enabled: true, scenarios: { default: CAPABLE }, ...overrides } as RouterConfig;
}

const BUDGET: AttemptRetryBudget = {
  zeroUsage: { enabled: true, maxAttempts: 5 },
  transient: { enabled: true, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 },
};

function outcome(overrides: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return { buffered: [], shouldRetryZeroUsage: false, ...overrides };
}

function error(code: string, extra: Partial<CanonicalModelError> = {}): CanonicalModelError {
  return { provider: CAPABLE.provider, protocol: "openai", code, message: code, retryable: true, ...extra };
}

// ── planAttemptExecution ────────────────────────────────────────────────

test("候选分档：全能力候选在前、降级候选在后，各带 downgradeUnsupportedMedia 标记", () => {
  const plan = planAttemptExecution(
    decision(CAPABLE),
    IMAGE_REQUEST,
    config({ fallback: { default: [TEXT_ONLY] } }),
    fakeRuntime({ capable: TEXT_AND_IMAGE, textonly: TEXT }),
  );

  assert.deepEqual(plan.requiredModalities, ["image"]);
  assert.deepEqual(
    plan.attemptPlans.map(p => [p.attempt.provider, p.downgradeUnsupportedMedia]),
    [
      ["capable", false],
      ["textonly", true],
    ],
  );
  assert.equal(plan.requestedAttempt.id, CAPABLE.id);
});

test("候选去重：fallback 链里与决策同 provider/model 的条目只出现一次", () => {
  const plan = planAttemptExecution(
    decision(CAPABLE),
    TEXT_REQUEST,
    config({ fallback: { default: [CAPABLE, TEXT_ONLY] } }),
    fakeRuntime({ capable: TEXT_AND_IMAGE, textonly: TEXT }),
  );

  assert.deepEqual(
    plan.attemptPlans.map(p => p.attempt.id),
    [CAPABLE.id, TEXT_ONLY.id],
  );
});

test("重试预算：缺省取内置默认，显式配置覆盖，maxAttempts 有下限 1", () => {
  const defaults = planAttemptExecution(decision(CAPABLE), TEXT_REQUEST, config(), fakeRuntime());
  assert.deepEqual(defaults.retry, {
    zeroUsage: { enabled: true, maxAttempts: 5 },
    transient: { enabled: true, maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 8000 },
  });

  const explicit = planAttemptExecution(
    decision(CAPABLE),
    TEXT_REQUEST,
    config({
      zeroUsageRetry: { enabled: false, maxAttempts: 0 },
      transientRetry: { enabled: false, maxAttempts: 0, baseDelayMs: 3, maxDelayMs: 9 },
    }),
    fakeRuntime(),
  );
  assert.deepEqual(explicit.retry, {
    zeroUsage: { enabled: false, maxAttempts: 1 },
    transient: { enabled: false, maxAttempts: 1, baseDelayMs: 3, maxDelayMs: 9 },
  });
});

// ── planAttempt ────────────────────────────────────────────────────────

test("planAttempt：首个 attempt 保留决策的来源，后续 attempt 标为 fallback", () => {
  const plan = planAttemptExecution(
    decision(CAPABLE, { resolvedFrom: "tokenSaver" }),
    TEXT_REQUEST,
    config({ fallback: { default: [TEXT_ONLY] } }),
    fakeRuntime({ textonly: TEXT }),
  );

  const first = planAttempt(
    decision(CAPABLE, { resolvedFrom: "tokenSaver" }),
    plan.attemptPlans[0],
    0,
    TEXT_REQUEST,
    fakeRuntime(),
  );
  assert.equal(first.attemptDecision.resolvedFrom, "tokenSaver");
  assert.equal(first.attemptDecision.model, CAPABLE.model);

  const second = planAttempt(
    decision(CAPABLE, { resolvedFrom: "tokenSaver" }),
    plan.attemptPlans[1],
    1,
    TEXT_REQUEST,
    fakeRuntime({ textonly: TEXT }),
  );
  assert.equal(second.attemptDecision.resolvedFrom, "fallback");
  assert.equal(second.attemptDecision.provider, TEXT_ONLY.provider);
  assert.equal(second.attemptRequest.model, TEXT_ONLY.model);
});

test("planAttempt：降级档把不被支持的图片块换成占位文本，原文本保留", () => {
  const runtime = fakeRuntime({ capable: TEXT_AND_IMAGE, textonly: TEXT });
  const plan = planAttemptExecution(
    decision(CAPABLE),
    IMAGE_REQUEST,
    config({ fallback: { default: [TEXT_ONLY] } }),
    runtime,
  );
  const downgradedPlan = plan.attemptPlans.find(p => p.downgradeUnsupportedMedia);
  assert.ok(downgradedPlan, "图片请求 + text-only 候选应产出降级档");

  const { attemptRequest } = planAttempt(decision(CAPABLE), downgradedPlan, 1, IMAGE_REQUEST, runtime);
  const blocks = attemptRequest.messages[0].content;
  assert.equal(
    blocks.some(block => block.type === "image"),
    false,
    "降级档不得残留图片块",
  );
  assert.ok(
    blocks.some(block => block.type === "text" && block.text.includes("看看这张附图")),
    "原文本块应保留",
  );
});

// ── applyDecisionToRequest ─────────────────────────────────────────────

test("applyDecisionToRequest：超过模型上限时夹取，未知模型不夹取", () => {
  const request = { ...TEXT_REQUEST, maxOutputTokens: 8192 };
  const clamped = applyDecisionToRequest(decision(CAPABLE), request, fakeRuntime());
  assert.equal(clamped.maxOutputTokens, 4096);

  const throwing = {
    ...fakeRuntime(),
    getCapabilities: () => {
      throw new Error("unknown provider/model");
    },
  } as unknown as ModelRuntime;
  const untouched = applyDecisionToRequest(decision(CAPABLE), request, throwing);
  assert.equal(untouched.maxOutputTokens, 8192, "能力查询失败时应原样下沉，由校验层报错");
});

// ── classifyAttemptGate ────────────────────────────────────────────────

const GATE_BASE = {
  attemptCount: 2,
  retry: BUDGET,
  zeroUsageAttempt: 1,
  transientRetryCount: 0,
};

test("classifyAttemptGate：可回退错误且还有候选 → fallback", () => {
  const gate = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ error: error("rate_limit_error") }),
    hasYieldedContent: false,
    attemptIndex: 0,
  });
  assert.deepEqual(gate, { kind: "fallback" });
});

test("classifyAttemptGate：已产出内容后既不回退也不重试 → terminalFailure", () => {
  const gate = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ error: error("rate_limit_error") }),
    hasYieldedContent: true,
    attemptIndex: 0,
  });
  assert.deepEqual(gate, { kind: "terminalFailure" });
});

test("classifyAttemptGate：链尾的可回退错误落回传输重试，延迟取 retry-after 并封顶", () => {
  const gate = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ error: error("rate_limit_error", { retryAfterMs: 250 }) }),
    hasYieldedContent: false,
    attemptIndex: 1,
  });
  assert.deepEqual(gate, { kind: "transientRetry", delayMs: 250 });

  const capped = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ error: error("rate_limit_error", { retryAfterMs: 10_000 }) }),
    hasYieldedContent: false,
    attemptIndex: 1,
  });
  assert.deepEqual(capped, { kind: "transientRetry", delayMs: BUDGET.transient.maxDelayMs });
});

test("classifyAttemptGate：重试次数用尽或传输重试关闭 → terminalFailure", () => {
  const exhausted = classifyAttemptGate({
    ...GATE_BASE,
    transientRetryCount: BUDGET.transient.maxAttempts,
    outcome: outcome({ error: error("rate_limit_error", { retryAfterMs: 1 }) }),
    hasYieldedContent: false,
    attemptIndex: 1,
  });
  assert.deepEqual(exhausted, { kind: "terminalFailure" });

  const disabled = classifyAttemptGate({
    ...GATE_BASE,
    retry: { ...BUDGET, transient: { ...BUDGET.transient, enabled: false } },
    outcome: outcome({ error: error("rate_limit_error", { retryAfterMs: 1 }) }),
    hasYieldedContent: false,
    attemptIndex: 1,
  });
  assert.deepEqual(disabled, { kind: "terminalFailure" });
});

test("classifyAttemptGate：不可回退错误（非重试且不在可回退名单）→ terminalFailure", () => {
  const gate = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ error: error("some_unknown_failure", { retryable: false }) }),
    hasYieldedContent: false,
    attemptIndex: 0,
  });
  assert.deepEqual(gate, { kind: "terminalFailure" });
});

test("classifyAttemptGate：非重试但可跨 provider 的错误仍走 fallback（billing）", () => {
  const gate = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ error: error("billing", { retryable: false }) }),
    hasYieldedContent: false,
    attemptIndex: 0,
  });
  assert.deepEqual(gate, { kind: "fallback" });
});

test("classifyAttemptGate：空回合在额度内 → zeroUsageRetry，退避为 500ms × 次数", () => {
  const gate = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ shouldRetryZeroUsage: true }),
    hasYieldedContent: false,
    attemptIndex: 0,
  });
  assert.deepEqual(gate, { kind: "zeroUsageRetry", delayMs: 500 });

  const third = classifyAttemptGate({
    ...GATE_BASE,
    zeroUsageAttempt: 3,
    outcome: outcome({ shouldRetryZeroUsage: true }),
    hasYieldedContent: false,
    attemptIndex: 0,
  });
  assert.deepEqual(third, { kind: "zeroUsageRetry", delayMs: 1500 });
});

test("classifyAttemptGate：空回合额度用尽或已产出内容 → success（按成功收尾）", () => {
  const exhausted = classifyAttemptGate({
    ...GATE_BASE,
    zeroUsageAttempt: BUDGET.zeroUsage.maxAttempts,
    outcome: outcome({ shouldRetryZeroUsage: true }),
    hasYieldedContent: false,
    attemptIndex: 0,
  });
  assert.deepEqual(exhausted, { kind: "success" });

  const contentYielded = classifyAttemptGate({
    ...GATE_BASE,
    outcome: outcome({ shouldRetryZeroUsage: true }),
    hasYieldedContent: true,
    attemptIndex: 0,
  });
  assert.deepEqual(contentYielded, { kind: "success" });

  const disabled = classifyAttemptGate({
    ...GATE_BASE,
    retry: { ...BUDGET, zeroUsage: { ...BUDGET.zeroUsage, enabled: false } },
    outcome: outcome({ shouldRetryZeroUsage: true }),
    hasYieldedContent: false,
    attemptIndex: 0,
  });
  assert.deepEqual(disabled, { kind: "success" });
});

// ── subagentBudgetError ────────────────────────────────────────────────

test("subagentBudgetError：非子代理或无预算配置时无判定", () => {
  assert.equal(subagentBudgetError(decision(CAPABLE), config(), CAPABLE, TEXT_REQUEST, "openai"), undefined);
  assert.equal(
    subagentBudgetError(
      decision(CAPABLE, { isSubagent: true }),
      config({ autoOrchestrate: { enabled: true, triggerTiers: [], slimSystemPrompt: false } }),
      CAPABLE,
      TEXT_REQUEST,
      "openai",
    ),
    undefined,
  );
});

test("subagentBudgetError：超预算给出带 userHint 的不可重试错误，协议随调用方", () => {
  const budgetError = subagentBudgetError(
    decision(CAPABLE, { isSubagent: true }),
    config({ autoOrchestrate: { enabled: true, triggerTiers: [], slimSystemPrompt: false, subagentMaxTokens: 1 } }),
    CAPABLE,
    TEXT_REQUEST,
    "anthropic",
  );
  assert.ok(budgetError);
  assert.equal(budgetError.code, "subagent_budget_exceeded");
  assert.equal(budgetError.retryable, false);
  assert.equal(budgetError.provider, CAPABLE.provider);
  assert.equal(budgetError.protocol, "anthropic");
  assert.ok(budgetError.userHint && budgetError.userHint.length > 0);
});

test("subagentBudgetError：额度内的子代理放行", () => {
  assert.equal(
    subagentBudgetError(
      decision(CAPABLE, { isSubagent: true }),
      config({
        autoOrchestrate: { enabled: true, triggerTiers: [], slimSystemPrompt: false, subagentMaxTokens: 100_000 },
      }),
      CAPABLE,
      TEXT_REQUEST,
      "openai",
    ),
    undefined,
  );
});
