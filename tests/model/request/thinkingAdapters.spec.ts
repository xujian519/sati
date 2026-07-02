import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRequest } from "../../../src/model/index.js";
import type { CanonicalModelRequest, ModelCapabilities, ModelConfig, ModelDefinition, ModelProtocol, ProviderConfig } from "../../../src/model/index.js";

const capabilities: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: true,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 16_384,
};

const messages: CanonicalModelRequest["messages"] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

test("GLM-5.2 Max sends thinking enabled and reasoning_effort=max", () => {
  const body = bodyFor("zai", "openai", "glm-5.2", { mode: "max", enabled: true });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
});

test("GLM-4.6 High sends thinking enabled without reasoning_effort", () => {
  const body = bodyFor("zai", "openai", "glm-4.6", { mode: "high", enabled: true });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, undefined);
});

test("Qwen hybrid Off and High map to enable_thinking and budget", () => {
  const off = bodyFor("dashscope", "openai", "qwen3-next-hybrid", { mode: "off", enabled: false });
  assert.deepEqual(off.extra_body, { enable_thinking: false });

  const high = bodyFor("dashscope", "openai", "qwen3-next-hybrid", { mode: "high", enabled: true });
  assert.deepEqual(high.extra_body, { enable_thinking: true, thinking_budget: 24576 });
});

test("DeepSeek Medium and Max legalize to high/max effort", () => {
  const medium = bodyFor("deepseek", "openai", "deepseek-chat", { mode: "medium", enabled: true });
  assert.deepEqual(medium.extra_body, { thinking: { type: "enabled" }, enable_thinking: true });
  assert.equal(medium.reasoning_effort, "high");

  const max = bodyFor("deepseek", "openai", "deepseek-chat", { mode: "max", enabled: true });
  assert.equal(max.reasoning_effort, "max");
});

test("Kimi K2.6 Off disables thinking without effort or budget", () => {
  const body = bodyFor("moonshot", "openai", "kimi-k2.6", { mode: "off", enabled: false });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking_budget, undefined);
  assert.equal(body.temperature, undefined);
});

test("MiniMax M2 enables reasoning_split without fake effort", () => {
  const body = bodyFor("minimax", "openai", "minimax-m2", { mode: "medium", enabled: true });
  assert.equal(body.reasoning_split, true);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking_budget, undefined);
});

test("GPT-5.5 Pro Low legalizes to Medium", () => {
  const body = bodyFor("openai", "openai-responses", "gpt-5.5-pro", { mode: "low", enabled: true });
  assert.deepEqual(body.reasoning, { effort: "medium" });
});

test("Gemini 3.1 Pro uses thinkingLevel not thinkingBudget", () => {
  const body = bodyFor("google", "google", "gemini-3.1-pro", { mode: "medium", enabled: true });
  assert.deepEqual(body.config.thinkingConfig, { includeThoughts: true, thinkingLevel: "medium" });
});

function bodyFor(providerId: string, protocol: ModelProtocol, modelId: string, thinking: CanonicalModelRequest["thinking"]): any {
  const request: CanonicalModelRequest = {
    provider: providerId,
    model: modelId,
    messages,
    stream: true,
    thinking,
  };
  return buildModelRequest(request, configFor(providerId, protocol, modelId)) as any;
}

function configFor(providerId: string, protocol: ModelProtocol, modelId: string): ModelConfig {
  const model: ModelDefinition = {
    id: modelId,
    capabilities,
    multimodal: { input: ["text"] },
  };
  const provider: ProviderConfig = {
    id: providerId,
    protocol,
    url: `https://${providerId}.example.invalid/v1`,
    apiKey: "test",
    headers: {},
    models: { [modelId]: model },
  };
  return { providers: { [providerId]: provider } };
}
