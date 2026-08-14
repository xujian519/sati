import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRequest } from "../../../src/model/index.js";
import type {
  CanonicalModelRequest,
  ModelCapabilities,
  ModelConfig,
  ModelDefinition,
  ProviderConfig,
} from "../../../src/model/index.js";

test("openai-responses omits temperature for reasoning-only models (deepseek-v4)", () => {
  const body = buildModelRequest(request("deepseek-v4-flash"), modelConfig("deepseek-v4-flash")) as {
    temperature?: number;
  };
  assert.equal(body.temperature, undefined);
});

test("openai-responses keeps temperature for non-reasoning models", () => {
  const body = buildModelRequest(request("gpt-4o"), modelConfig("gpt-4o")) as { temperature?: number };
  assert.equal(body.temperature, 0.7);
});

function request(model: string): CanonicalModelRequest {
  return {
    provider: "openai-responses",
    model,
    stream: true,
    temperature: 0.7,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
}

function modelConfig(modelId: string): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: true,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
  };
  const model: ModelDefinition = {
    id: modelId,
    capabilities,
    multimodal: { input: ["text"] },
  };
  const provider: ProviderConfig = {
    id: "openai-responses",
    protocol: "openai-responses",
    url: "https://api.openai.com/v1",
    apiKey: "test",
    headers: {},
    models: { [modelId]: model },
  };
  return { providers: { "openai-responses": provider } };
}
