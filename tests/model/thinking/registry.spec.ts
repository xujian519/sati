import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalThinkingConfig,
  ModelCapabilities,
  ModelDefinition,
  ProviderConfig,
} from "../../../src/model/index.js";
import { resolveThinkingPlan } from "../../../src/model/thinking/registry.js";

// DeepSeek v4 与 Kimi K3/K2.7 的官方思考语义（对照 2026 年中官方文档）：
// - deepseek-v4-flash：reasoning_effort 支持 low/high/max；v4-pro 目前仅 high/max；
//   off 通过 thinking.type=disabled 显式关闭（useOpenAICompatibleThinking 路径）。
// - kimi-k3 / kimi-k2.7-code(-highspeed)：始终思考不可关闭，顶层 reasoning_effort；
//   off 必须返回 unsupportedReason，不得发出 thinking.type=disabled。
// - kimi-k2.6：思考+非思考双模式，off 走 thinking.type=disabled。

test("deepseek-v4-flash maps effort to low/high/max with openai-compatible thinking", () => {
  const plan = planFor("deepseek", "deepseek-v4-flash", { mode: "high", enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.thinkingType, "enabled");
  assert.equal(plan.effort, "high");
  assert.equal(plan.useOpenAICompatibleThinking, true);
});

test("deepseek-v4-flash clamps medium to low and xhigh to max", () => {
  const medium = planFor("deepseek", "deepseek-v4-flash", { mode: "medium", enabled: true });
  assert.equal(medium.effort, "low");
  const xhigh = planFor("deepseek", "deepseek-v4-flash", { mode: "xhigh", enabled: true });
  assert.equal(xhigh.effort, "max");
});

test("deepseek-v4-pro restricts effort to high/max", () => {
  const low = planFor("deepseek", "deepseek-v4-pro", { mode: "low", enabled: true });
  assert.equal(low.effort, "high");
  const max = planFor("deepseek", "deepseek-v4-pro", { mode: "max", enabled: true });
  assert.equal(max.effort, "max");
});

test("deepseek-v4 off disables thinking via thinking.type=disabled", () => {
  const plan = planFor("deepseek", "deepseek-v4-flash", { mode: "off", enabled: true });
  assert.equal(plan.enabled, false);
  assert.equal(plan.thinkingType, "disabled");
});

test("deprecated deepseek-chat keeps legacy high/max effort semantics", () => {
  const medium = planFor("deepseek", "deepseek-chat", { mode: "medium", enabled: true });
  assert.equal(medium.effort, "high");
  const low = planFor("deepseek", "deepseek-chat", { mode: "low", enabled: true });
  assert.equal(low.effort, "high");
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

test("kimi-k2.6 keeps dual-mode behavior (off -> thinking.type=disabled)", () => {
  const off = planFor("moonshot", "kimi-k2.6", { mode: "off", enabled: true });
  assert.equal(off.enabled, false);
  assert.equal(off.thinkingType, "disabled");
  assert.equal(off.useOpenAICompatibleThinking, true);
});

test("default thinking mode keeps thinking disabled without adapter", () => {
  const plan = planFor("deepseek", "deepseek-v4-flash", undefined);
  assert.equal(plan.enabled, false);
});

function planFor(providerId: string, modelId: string, thinking: CanonicalThinkingConfig | undefined) {
  return resolveThinkingPlan(thinking, provider(providerId, modelId), model(modelId));
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
    url: id === "moonshot" ? "https://api.moonshot.cn/v1" : "https://api.deepseek.com/v1",
    apiKey: "test",
    headers: {},
    models: { [modelId]: model(modelId) },
  };
}
