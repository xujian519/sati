import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRequest } from "../../../src/model/index.js";
import { ModelRequestError } from "../../../src/model/index.js";
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
  assert.equal(off.enable_thinking, false);

  const high = bodyFor("dashscope", "openai", "qwen3-next-hybrid", { mode: "high", enabled: true });
  assert.equal(high.enable_thinking, true);
  assert.equal(high.thinking_budget, 24576);
});

test("DeepSeek Medium and Max legalize to high/max effort", () => {
  const medium = bodyFor("deepseek", "openai", "deepseek-chat", { mode: "medium", enabled: true });
  assert.deepEqual(medium.thinking, { type: "enabled" });
  assert.equal(medium.reasoning_effort, "high");

  const max = bodyFor("deepseek", "openai", "deepseek-chat", { mode: "max", enabled: true });
  assert.equal(max.reasoning_effort, "max");
});

test("ModelBest Qwen uses thinking/reasoning_effort instead of enable_thinking", () => {
  const high = bodyFor("qwen", "openai", "QWEN_40e5sh", { mode: "high", enabled: true }, "https://llm-center.ali.modelbest.cn/llm/v1");
  assert.deepEqual(high.thinking, { type: "enabled" });
  assert.equal(high.reasoning_effort, "high");
  assert.equal(high.enable_thinking, undefined);
});

test("ModelBest DeepSeek avoids combining thinking and reasoning_effort", () => {
  const high = bodyFor("deepseek", "openai", "DEEPSEEK_rtwgny", { mode: "high", enabled: true }, "https://llm-center.ali.modelbest.cn/llm/v1");
  assert.deepEqual(high.thinking, { type: "enabled" });
  assert.equal(high.reasoning_effort, undefined);
});

test("Kimi K2.6 Off disables thinking without effort or budget", () => {
  const body = bodyFor("moonshot", "openai", "kimi-k2.6", { mode: "off", enabled: false });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking_budget, undefined);
  assert.equal(body.temperature, undefined);
});

test("MiniMax M2 supports Off and reasoning split without fake effort", () => {
  const off = bodyFor("minimax", "openai", "minimax-m2", { mode: "off", enabled: false });
  assert.deepEqual(off.thinking, { type: "disabled" });

  const body = bodyFor("minimax", "openai", "minimax-m2", { mode: "medium", enabled: true });
  assert.equal(body.reasoning_split, true);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking_budget, undefined);
});

test("GPT-5.5 Pro Low legalizes to Medium", () => {
  const body = bodyFor("openai", "openai-responses", "gpt-5.5-pro", { mode: "low", enabled: true });
  assert.deepEqual(body.reasoning, { effort: "medium" });
});

test("OpenAI o-series maps explicit thinking to reasoning effort", () => {
  const body = bodyFor("openai", "openai-responses", "o3", { mode: "high", enabled: true });
  assert.deepEqual(body.reasoning, { effort: "high" });
});

test("OpenAI GPT-5 explicit Off reports unsupported instead of silently no-oping", () => {
  assert.throws(
    () => bodyFor("openai", "openai-responses", "gpt-5", { mode: "off", enabled: false }),
    (error: unknown) => error instanceof ModelRequestError
      && error.code === "unsupported_thinking"
      && /does not support an explicit off thinking mode/.test(error.message)
      && /Switch thinking strength back to Default/.test(error.message),
  );
});

test("official OpenAI unknown model reports unsupported thinking", () => {
  assert.throws(
    () => bodyFor("openai", "openai", "plain-chat", { mode: "high", enabled: true }),
    (error: unknown) => error instanceof ModelRequestError
      && error.code === "unsupported_thinking"
      && /Switch thinking strength back to Default/.test(error.message),
  );
});

test("Gemini 3.1 Pro uses thinkingLevel not thinkingBudget", () => {
  const body = bodyFor("google", "google", "gemini-3.1-pro", { mode: "medium", enabled: true });
  assert.deepEqual(body.config.thinkingConfig, { includeThoughts: true, thinkingLevel: "medium" });
});

test("unknown model without supportsThinking uses generic thinking budget", () => {
  const body = bodyFor("local", "openai", "plain-chat", { mode: "high", enabled: true }, "https://local.example.invalid/v1", undefined);
  assert.equal(body.enable_thinking, true);
  assert.equal(body.thinking_budget, 24576);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
});

test("unknown supportsThinking model supports generic off", () => {
  const body = bodyFor("local", "openai", "plain-thinking-chat", { mode: "off", enabled: false }, "https://local.example.invalid/v1", true);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
});

test("unknown explicitly unsupported thinking model reports actionable error", () => {
  assert.throws(
    () => bodyFor("local", "openai", "plain-no-thinking-chat", { mode: "high", enabled: true }, "https://local.example.invalid/v1", false),
    (error: unknown) => error instanceof ModelRequestError
      && error.code === "unsupported_thinking"
      && /Switch thinking strength back to Default/.test(error.message),
  );
});

test("legacy disabled thinking remains a no-op for ordinary models", () => {
  const body = bodyFor("local", "openai", "plain-chat", { enabled: false }, "https://local.example.invalid/v1", false);
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.enable_thinking, undefined);
});

function bodyFor(providerId: string, protocol: ModelProtocol, modelId: string, thinking: CanonicalModelRequest["thinking"], url?: string, supportsThinking: boolean | undefined = true): any {
  const request: CanonicalModelRequest = {
    provider: providerId,
    model: modelId,
    messages,
    stream: true,
    thinking,
  };
  return buildModelRequest(request, configFor(providerId, protocol, modelId, url, supportsThinking)) as any;
}

function configFor(providerId: string, protocol: ModelProtocol, modelId: string, url?: string, supportsThinking: boolean | undefined = true): ModelConfig {
  const model: ModelDefinition = {
    id: modelId,
    capabilities: {
      ...capabilities,
      ...(supportsThinking === undefined ? {} : { supportsThinking, supportsThinkingExplicit: supportsThinking }),
    } as ModelCapabilities,
    multimodal: { input: ["text"] },
  };
  const provider: ProviderConfig = {
    id: providerId,
    protocol,
    url: url ?? `https://${providerId}.example.invalid/v1`,
    apiKey: "test",
    headers: {},
    models: { [modelId]: model },
  };
  return { providers: { [providerId]: provider } };
}
