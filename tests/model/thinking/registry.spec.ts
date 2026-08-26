import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalThinkingConfig,
  ModelCapabilities,
  ModelDefinition,
  ProviderConfig,
} from "../../../src/model/index.js";
import { resolveThinkingPlan } from "../../../src/model/thinking/registry.js";

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
  const low = planFor("deepseek", "deepseek-chat", { mode: "low", enabled: true });
  assert.equal(low.effort, "high");
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
