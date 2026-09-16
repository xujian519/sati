import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalThinkingConfig,
  ModelCapabilities,
  ModelDefinition,
  ProviderConfig,
} from "../../../src/model/index.js";
import {
  defaultAgentThinking,
  resolveThinkingPlan,
  throwIfUnsupportedThinkingPlan,
  type ThinkingMode,
  type ThinkingPlan,
} from "../../../src/model/thinking/registry.js";

// DeepSeek v4 与 Kimi K3/K2.7 的官方思考语义（对照 2026-08 官方文档）：
// - deepseek-v4-flash / deepseek-v4-pro：reasoning_effort 均支持 low/high/max，
//   两型号 effort 映射一致（medium→high, xhigh→max）；
//   off 通过 thinking.type=disabled 显式关闭（useOpenAICompatibleThinking 路径）。
// - kimi-k3：始终思考不可关闭，顶层 reasoning_effort（low/high/max，默认 max）；
//   kimi-k2.7-code(-highspeed)：始终思考，但不支持 reasoning_effort（仅 k3 发送）；
//   off 必须返回 unsupportedReason，不得发出 thinking.type=disabled。
// - kimi-k2.6：思考+非思考双模式，off 走 thinking.type=disabled。

test("deepseek-v4-flash maps effort to low/high/max with openai-compatible thinking", () => {
  const plan = planFor("deepseek", "deepseek-v4-flash", { mode: "high", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.thinkingType, "enabled");
  assert.equal(plan.effort, "high");
  assert.equal(plan.useOpenAICompatibleThinking, true);
  // 推理模型仅接受 temperature=1（或省略），显式温度一律省略。
  assert.equal(plan.omitTemperature, true);
});

test("deepseek-v4-flash maps medium to high and xhigh to max", () => {
  const medium = planFor("deepseek", "deepseek-v4-flash", { mode: "medium", enabled: true });
  assert.equal(medium.effort, "high");
  const xhigh = planFor("deepseek", "deepseek-v4-flash", { mode: "xhigh", enabled: true });
  assert.equal(xhigh.effort, "max");
});

test("deepseek-v4-pro supports the full low/high/max effort range", () => {
  const low = planFor("deepseek", "deepseek-v4-pro", { mode: "low", enabled: true });
  assert.equal(low.effort, "low");
  const max = planFor("deepseek", "deepseek-v4-pro", { mode: "max", enabled: true });
  assert.equal(max.effort, "max");
});

test("deepseek-v4 off disables thinking via thinking.type=disabled", () => {
  const plan = planFor("deepseek", "deepseek-v4-flash", { mode: "off", enabled: true });
  assert.equal(plan.enabled, false);
  assert.equal(plan.thinkingType, "disabled");
  // off 分支同样省略温度（v4 仅接受 temperature=1 或省略）。
  assert.equal(plan.omitTemperature, true);
});

test("deprecated deepseek-chat keeps legacy high/max effort semantics", () => {
  const medium = planFor("deepseek", "deepseek-chat", { mode: "medium", enabled: true });
  assert.equal(medium.effort, "high");
  // low 不在旧模型的允许集合（high/max）内：不再就近夹取成 high，而是显式报不支持
  // （上游 #587 判据改进——静默降级会让用户以为所选强度生效了）。
  const low = planFor("deepseek", "deepseek-chat", { mode: "low", enabled: true });
  assert.equal(low.effort, undefined);
  assert.match(low.unsupportedReason ?? "", /does not support thinking strength 'low'/);
  assert.match(low.unsupportedReason ?? "", /Supported: high, max\./);
});

test("non-reasoning deepseek-chat keeps explicit temperature (no omitTemperature)", () => {
  const plan = planFor("deepseek", "deepseek-chat", { mode: "high", enabled: true });
  assert.equal(plan.omitTemperature, undefined);
});

test("non-reasoning kimi-moonshot-v1 keeps explicit temperature (no omitTemperature)", () => {
  const plan = planFor("moonshot", "kimi-moonshot-v1-32k", undefined);
  assert.equal(plan.enabled, false);
  assert.equal(plan.omitTemperature, undefined);
});

test("deprecated deepseek-reasoner rejects explicit off (always-thinking)", () => {
  const plan = planFor("deepseek", "deepseek-reasoner", { mode: "off", enabled: true });
  assert.match(plan.unsupportedReason ?? "", /always thinks/);
});

test("kimi-k3 rejects explicit off (always-thinking) with unsupportedReason", () => {
  const plan = planFor("moonshot", "kimi-k3", { mode: "off", enabled: true });
  assert.equal(plan.enabled, false);
  assert.match(plan.unsupportedReason ?? "", /always thinks/);
});

test("kimi-k3 maps non-off modes to reasoning_effort bodyPatch", () => {
  const high = planFor("moonshot", "kimi-k3", { mode: "high", enabled: true });
  assert.equal(high.enabled, true);
  assert.deepEqual(high.bodyPatch, { reasoning_effort: "high" });
  const max = planFor("moonshot", "kimi-k3", { mode: "max", enabled: true });
  assert.deepEqual(max.bodyPatch, { reasoning_effort: "max" });
});

test("kimi-k2.7-code-highspeed rejects explicit off", () => {
  const plan = planFor("moonshot", "kimi-k2.7-code-highspeed", { mode: "off", enabled: true });
  assert.match(plan.unsupportedReason ?? "", /always thinks/);
});

test("kimi-k2.7-code never sends reasoning_effort (API does not support it)", () => {
  const high = planFor("moonshot", "kimi-k2.7-code", { mode: "high", enabled: true });
  assert.equal(high.enabled, true);
  assert.equal(high.bodyPatch, undefined);
  assert.equal(high.omitTemperature, true);
  const max = planFor("moonshot", "kimi-k2.7-code-highspeed", { mode: "max", enabled: true });
  assert.equal(max.enabled, true);
  assert.equal(max.bodyPatch, undefined);
});

test("kimi-k2.6 keeps dual-mode behavior (off -> thinking.type=disabled)", () => {
  const off = planFor("moonshot", "kimi-k2.6", { mode: "off", enabled: true });
  assert.equal(off.enabled, false);
  assert.equal(off.thinkingType, "disabled");
  assert.equal(off.useOpenAICompatibleThinking, true);
});

test("minimax M2.x rejects explicit off (always-thinking, no user switch)", () => {
  const off = planFor("minimax", "MiniMax-M2.7", { mode: "off", enabled: true });
  assert.equal(off.enabled, false);
  assert.equal(off.thinkingType, undefined);
  assert.match(off.unsupportedReason ?? "", /always thinks/);
});

test("minimax M3 maps explicit off to thinking.type=disabled", () => {
  const off = planFor("minimax", "MiniMax-M3", { mode: "off", enabled: true });
  assert.equal(off.enabled, false);
  assert.equal(off.thinkingType, "disabled");
  assert.equal(off.useOpenAICompatibleThinking, true);
  assert.equal(off.unsupportedReason, undefined);
});

test("minimax M2.x keeps splitReasoning for non-off modes", () => {
  const high = planFor("minimax", "MiniMax-M2.5", { mode: "high", enabled: true });
  assert.equal(high.enabled, true);
  assert.equal(high.splitReasoning, true);
});

test("default deepseek-v4 explicitly disables thinking via openai-compatible disabled", () => {
  const plan = planFor("deepseek", "deepseek-v4-flash", undefined);
  assert.equal(plan.enabled, false);
  assert.equal(plan.thinkingType, "disabled");
  assert.equal(plan.useOpenAICompatibleThinking, true);
  assert.equal(plan.omitTemperature, true);
  const pro = planFor("deepseek", "deepseek-v4-pro", undefined);
  assert.equal(pro.thinkingType, "disabled");
  assert.equal(pro.useOpenAICompatibleThinking, true);
});

test("defaultAgentThinking opts deepseek-v4 into medium thinking for the agent loop", () => {
  assert.deepEqual(defaultAgentThinking("deepseek-v4-flash"), { mode: "medium", enabled: true });
  assert.deepEqual(defaultAgentThinking("deepseek-v4-pro"), { mode: "medium", enabled: true });
  // 大小写不敏感。
  assert.deepEqual(defaultAgentThinking("DeepSeek-V4-Flash"), { mode: "medium", enabled: true });
});

test("defaultAgentThinking returns undefined for non-deepseek-v4 models", () => {
  assert.equal(defaultAgentThinking("deepseek-reasoner"), undefined);
  assert.equal(defaultAgentThinking("deepseek-chat"), undefined);
  assert.equal(defaultAgentThinking("kimi-k3"), undefined);
  assert.equal(defaultAgentThinking("claude-opus-4.8"), undefined);
  assert.equal(defaultAgentThinking("MiniMax-M3"), undefined);
});

test("default deepseek-reasoner keeps legacy behavior (no thinking field)", () => {
  const plan = planFor("deepseek", "deepseek-reasoner", undefined);
  assert.equal(plan.enabled, false);
  assert.equal(plan.thinkingType, undefined);
  assert.equal(plan.useOpenAICompatibleThinking, undefined);
  assert.equal(plan.omitTemperature, true);
});

test("default thinking mode keeps thinking disabled but omits temperature for deepseek", () => {
  const plan = planFor("deepseek", "deepseek-v4-flash", undefined);
  assert.equal(plan.enabled, false);
  assert.equal(plan.omitTemperature, true);
});

test("default thinking mode omits temperature for kimi reasoning models", () => {
  const plan = planFor("moonshot", "kimi-k2.6", undefined);
  assert.equal(plan.enabled, false);
  assert.equal(plan.omitTemperature, true);
});

test("default thinking mode for other providers keeps no omitTemperature", () => {
  const plan = planForOpenAI("openai", "gpt-5.5", undefined);
  assert.equal(plan.enabled, false);
  assert.equal(plan.omitTemperature, undefined);
});

test("gpt-5.5-off maps to reasoning_effort none (not disabled)", () => {
  const plan = planForOpenAI("openai", "gpt-5.5", { mode: "off", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.useOpenAIReasoning, true);
  assert.equal(plan.effort, "none");
});

test("gpt-5.5 low maps to reasoning_effort low", () => {
  const plan = planForOpenAI("openai", "gpt-5.5", { mode: "low", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.effort, "low");
  assert.equal(plan.useOpenAIReasoning, true);
});

test("gpt-5.5 max maps to reasoning_effort max", () => {
  const plan = planForOpenAI("openai", "gpt-5.5", { mode: "max", enabled: true });
  assert.equal(plan.effort, "max");
});

test("gpt-5.6-sol off maps to reasoning_effort none", () => {
  const plan = planForOpenAI("openai", "gpt-5.6-sol", { mode: "off", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.effort, "none");
  assert.equal(plan.useOpenAIReasoning, true);
});

test("gpt-5.6-sol high maps to reasoning_effort high", () => {
  const plan = planForOpenAI("openai", "gpt-5.6-sol", { mode: "high", enabled: true });
  assert.equal(plan.effort, "high");
  assert.equal(plan.useOpenAIReasoning, true);
});

test("claude-opus-4.8 uses adaptive thinking with output_config effort", () => {
  const plan = planForAnthropic("anthropic", "claude-opus-4.8", { mode: "high", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.thinkingType, "adaptive");
  assert.equal(plan.useAnthropicOutputEffort, true);
  assert.equal(plan.effort, "high");
});

test("claude-sonnet-5 uses adaptive thinking", () => {
  const plan = planForAnthropic("anthropic", "claude-sonnet-5", { mode: "medium", enabled: true });
  assert.equal(plan.thinkingType, "adaptive");
  assert.equal(plan.useAnthropicOutputEffort, true);
  assert.equal(plan.effort, "medium");
});

test("claude-sonnet-4.6 uses adaptive thinking", () => {
  const plan = planForAnthropic("anthropic", "claude-sonnet-4.6", { mode: "high", enabled: true });
  assert.equal(plan.thinkingType, "adaptive");
  assert.equal(plan.useAnthropicOutputEffort, true);
});

test("claude-sonnet-4.5 uses legacy enabled thinking with budget", () => {
  const plan = planForAnthropic("anthropic", "claude-sonnet-4.5", { mode: "high", enabled: true });
  assert.equal(plan.thinkingType, "enabled");
  assert.equal(plan.useAnthropicOutputEffort, undefined);
  assert.ok(plan.budgetTokens !== undefined);
});

test("gemini-3.1-pro-preview uses thinkingLevel (cannot be disabled)", () => {
  const on = planForGoogle("google", "gemini-3.1-pro-preview", { mode: "high", enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.thinkingLevel, "high");
  assert.equal(on.useGeminiLevel, true);
});

test("gemini-3.6-flash uses thinkingLevel", () => {
  const plan = planForGoogle("google", "gemini-3.6-flash", { mode: "medium", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.thinkingLevel, "medium");
  assert.equal(plan.useGeminiLevel, true);
});

test("gemini-2.5-pro uses thinkingBudget", () => {
  const plan = planForGoogle("google", "gemini-2.5-pro", { mode: "high", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.useGeminiBudget, true);
  assert.ok(plan.budgetTokens !== undefined);
});

/** 阿里云 llm-center 的 qwen 分支：允许集合上界是 xhigh（没有 max 档）。 */
function planForQwenAli(mode: ThinkingMode): ThinkingPlan {
  return resolveThinkingPlan(
    { mode, enabled: true },
    {
      id: "qwen",
      protocol: "openai",
      url: "https://llm-center.ali.modelbest.cn/v1",
      apiKey: "test",
      headers: {},
      models: {},
    },
    model("qwen3-max"),
  );
}

function planFor(providerId: string, modelId: string, thinking: CanonicalThinkingConfig | undefined) {
  return resolveThinkingPlan(thinking, provider(providerId, modelId), model(modelId));
}

function planForOpenAI(providerId: string, modelId: string, thinking: CanonicalThinkingConfig | undefined) {
  return resolveThinkingPlan(thinking, openaiProvider(providerId), model(modelId));
}

function planForAnthropic(providerId: string, modelId: string, thinking: CanonicalThinkingConfig | undefined) {
  return resolveThinkingPlan(thinking, anthropicProvider(providerId), model(modelId));
}

function planForGoogle(providerId: string, modelId: string, thinking: CanonicalThinkingConfig | undefined) {
  return resolveThinkingPlan(thinking, googleProvider(providerId), model(modelId));
}

const capabilities: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: true,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 1_048_576,
  maxOutputTokens: 393_216,
};

function model(id: string): ModelDefinition {
  return { id, capabilities, multimodal: { input: ["text"] } };
}

function provider(id: string, modelId: string): ProviderConfig {
  return {
    id,
    protocol: "openai",
    url:
      id === "moonshot"
        ? "https://api.moonshot.cn/v1"
        : id === "minimax"
          ? "https://api.minimaxi.com/v1"
          : "https://api.deepseek.com/v1",
    apiKey: "test",
    headers: {},
    models: { [modelId]: model(modelId) },
  };
}

function openaiProvider(id: string): ProviderConfig {
  return {
    id,
    protocol: "openai",
    url: "https://api.openai.com/v1",
    apiKey: "test",
    headers: {},
    models: {},
  };
}

function anthropicProvider(id: string): ProviderConfig {
  return {
    id,
    protocol: "anthropic",
    url: "https://api.anthropic.com",
    apiKey: "test",
    headers: {},
    models: {},
  };
}

function googleProvider(id: string): ProviderConfig {
  return {
    id,
    protocol: "google",
    url: "https://generativelanguage.googleapis.com",
    apiKey: "test",
    headers: {},
    models: {},
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * 不静默夹取（上游 #587 判据改进）
 *
 * 旧行为：请求的强度不在模型允许集合内时按 rank 距离**就近取整**，请求照常成功，
 * 用户看到的是一次"生效了"的调用。现在改为给出 unsupportedReason（渲染为
 * `unsupported_thinking` 错误），并把允许集合写进消息里供用户改选。
 * ──────────────────────────────────────────────────────────────────────── */

/** 十个 `effort` 判定点各一例：请求值不在允许集合内 → 报不支持且不产出 effort。 */
const UNSUPPORTED_CASES: Array<{
  name: string;
  plan: () => ThinkingPlan;
  mode: string;
  supported: string;
}> = [
  {
    name: "gpt-5.5-pro / low（允许集合从 medium 起）",
    plan: () => planForOpenAI("openai", "gpt-5.5-pro", { mode: "low", enabled: true }),
    mode: "low",
    supported: "medium, high, xhigh, max",
  },
  {
    name: "gpt-5.6-sol / minimal",
    plan: () => planForOpenAI("openai", "gpt-5.6-sol", { mode: "minimal", enabled: true }),
    mode: "minimal",
    supported: "none, low, medium, high, xhigh, max",
  },
  {
    name: "gpt-5.5 / minimal",
    plan: () => planForOpenAI("openai", "gpt-5.5", { mode: "minimal", enabled: true }),
    mode: "minimal",
    supported: "none, low, medium, high, xhigh, max",
  },
  {
    name: "gpt-5 / xhigh（plain gpt-5 只到 high）",
    plan: () => planForOpenAI("openai", "gpt-5", { mode: "xhigh", enabled: true }),
    mode: "xhigh",
    supported: "none, low, medium, high",
  },
  {
    name: "o3 / minimal",
    plan: () => planForOpenAI("openai", "o3-mini", { mode: "minimal", enabled: true }),
    mode: "minimal",
    supported: "low, medium, high",
  },
  {
    name: "claude-opus-4.8 / minimal",
    plan: () => planForAnthropic("anthropic", "claude-opus-4.8", { mode: "minimal", enabled: true }),
    mode: "minimal",
    supported: "low, medium, high, max",
  },
  {
    name: "deepseek-v4-flash / minimal",
    plan: () => planFor("deepseek", "deepseek-v4-flash", { mode: "minimal", enabled: true }),
    mode: "minimal",
    supported: "low, high, max",
  },
  {
    name: "deprecated deepseek-chat / low（旧模型只到 high/max）",
    plan: () => planFor("deepseek", "deepseek-chat", { mode: "low", enabled: true }),
    mode: "low",
    supported: "high, max",
  },
  {
    name: "kimi-k3 / minimal",
    plan: () => planFor("moonshot", "kimi-k3", { mode: "minimal", enabled: true }),
    mode: "minimal",
    supported: "low, high, max",
  },
];

for (const testCase of UNSUPPORTED_CASES) {
  test(`不夹取：${testCase.name} → unsupportedReason 且不产出 effort`, () => {
    const plan = testCase.plan();
    assert.equal(plan.effort, undefined, "不得再就近取整出一个强度");
    assert.match(plan.unsupportedReason ?? "", new RegExp(`does not support thinking strength '${testCase.mode}'`));
    assert.ok(
      plan.unsupportedReason?.includes(`Supported: ${testCase.supported}.`),
      `消息须列出允许集合（实际：${plan.unsupportedReason}）`,
    );
  });
}

test("命中允许集合时精确透传，不带 unsupportedReason", () => {
  const cases: Array<[string, ThinkingPlan, string]> = [
    ["gpt-5.5-pro/high", planForOpenAI("openai", "gpt-5.5-pro", { mode: "high", enabled: true }), "high"],
    ["gpt-5/medium", planForOpenAI("openai", "gpt-5", { mode: "medium", enabled: true }), "medium"],
    ["o3/low", planForOpenAI("openai", "o3-mini", { mode: "low", enabled: true }), "low"],
    [
      "claude-opus-4.8/medium",
      planForAnthropic("anthropic", "claude-opus-4.8", { mode: "medium", enabled: true }),
      "medium",
    ],
    ["deepseek-v4-flash/low", planFor("deepseek", "deepseek-v4-flash", { mode: "low", enabled: true }), "low"],
    ["deepseek-chat/high", planFor("deepseek", "deepseek-chat", { mode: "high", enabled: true }), "high"],
    ["kimi-k3/low", planFor("moonshot", "kimi-k3", { mode: "low", enabled: true }), "low"],
  ];
  for (const [name, plan, expected] of cases) {
    assert.equal(plan.effort, expected, name);
    assert.equal(plan.unsupportedReason, undefined, name);
  }
});

test("别名锚：max 优先同名档；厂商把最高档叫 xhigh 时按同义别名接受", () => {
  // 同名档存在 → 用 max
  assert.equal(planForOpenAI("openai", "gpt-5.5", { mode: "max", enabled: true }).effort, "max");
  // 只有 xhigh（阿里云 qwen 分支的允许集合上界是 xhigh）→ 别名映射
  const aliased = planForQwenAli("max");
  assert.equal(aliased.effort, "xhigh");
  assert.equal(aliased.unsupportedReason, undefined);
  // 两者都不允许 → 报不支持，不再退到 high
  const unsupported = planForOpenAI("openai", "gpt-5", { mode: "max", enabled: true });
  assert.equal(unsupported.effort, undefined);
  assert.match(unsupported.unsupportedReason ?? "", /thinking strength 'max'/);
});

test("unsupported_thinking 经 throwIfUnsupportedThinkingPlan 抛出（错误码稳定）", () => {
  const plan = planFor("deepseek", "deepseek-chat", { mode: "low", enabled: true });
  assert.throws(
    () =>
      throwIfUnsupportedThinkingPlan(plan, {
        provider: "deepseek",
        model: "deepseek-chat",
        messages: [],
        stream: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "unsupported_thinking",
  );
});

test("支持的 plan 不抛错（同一出口不得误伤）", () => {
  const plan = planFor("deepseek", "deepseek-chat", { mode: "high", enabled: true });
  assert.doesNotThrow(() =>
    throwIfUnsupportedThinkingPlan(plan, {
      provider: "deepseek",
      model: "deepseek-chat",
      messages: [],
      stream: false,
    }),
  );
});
