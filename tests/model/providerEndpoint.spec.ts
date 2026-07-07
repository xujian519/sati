import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderChatEndpoint, buildProviderModelsEndpoint } from "../../src/model/providerEndpoint.js";

test("buildProviderChatEndpoint adds default protocol versions", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com" }),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-pro" }),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
  );
});

test("buildProviderChatEndpoint does not duplicate existing version segments", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com/v1" }),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai-responses", baseUrl: "https://api.openai.com/v1/" }),
    "https://api.openai.com/v1/responses",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com/v1", model: "gemini-pro" }),
    "https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent",
  );
});

test("buildProviderChatEndpoint preserves provider-specific API version paths", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.z.ai/api/paas/v4" }),
    "https://api.z.ai/api/paas/v4/chat/completions",
  );
});

test("buildProviderModelsEndpoint matches protocol version rules", () => {
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com" }),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com/v1" }),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }),
    "https://api.anthropic.com/v1/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com" }),
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
  );
});
