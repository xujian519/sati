import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRequest } from "../../../src/model/index.js";
import type { ModelCapabilities, ModelConfig, ModelDefinition, ProviderConfig } from "../../../src/model/index.js";

test("deepseek-v4 default request carries thinking.type=disabled", () => {
  const body = buildModelRequest(
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    },
    deepseekV4Config("deepseek-v4-flash"),
  ) as { thinking?: Record<string, unknown> };

  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("deepseek-v4 off request also carries thinking.type=disabled", () => {
  const body = buildModelRequest(
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      stream: false,
      thinking: { mode: "off", enabled: false },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    },
    deepseekV4Config("deepseek-v4-pro"),
  ) as { thinking?: Record<string, unknown> };

  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("deepseek-chat default keeps no thinking field (legacy semantics)", () => {
  const body = buildModelRequest(
    {
      provider: "deepseek",
      model: "deepseek-chat",
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    },
    deepseekV4Config("deepseek-chat"),
  ) as { thinking?: Record<string, unknown> };

  assert.equal(body.thinking, undefined);
});

function deepseekV4Config(modelId: string): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: true,
    supportsJsonSchema: false,
    supportsSystemPrompt: true,
    supportsPromptCache: true,
    maxContextTokens: 1_048_576,
    maxOutputTokens: 393_216,
  };
  const models: Record<string, ModelDefinition> = {
    [modelId]: { id: modelId, capabilities, multimodal: { input: ["text"] } },
  };
  const deepseek: ProviderConfig = {
    id: "deepseek",
    protocol: "openai",
    url: "https://api.deepseek.com/v1",
    apiKey: "test",
    headers: {},
    models,
  };
  return { providers: { deepseek } };
}
