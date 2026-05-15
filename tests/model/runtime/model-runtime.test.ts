import test from "node:test";
import assert from "node:assert/strict";
import { createModelRuntime, ModelProviderError, parseModelConfig } from "../../../src/model/index.js";
import { validModelConfig } from "../helpers.js";

test("creates a config-bound ModelRuntime with stable integration methods", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const runtime = createModelRuntime(config);

  const capabilities = runtime.getCapabilities("anthropic-main", "claude-sonnet-4-5");

  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
  assert.equal(capabilities.supportsThinking, true);
  assert.equal(capabilities.maxContextTokens, 200000);
});

test("complete normalizes non-json provider error responses", async () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const runtime = createModelRuntime(config, {
    fetch: async () => new Response("<!DOCTYPE html>bad gateway", { status: 502 }),
  });

  await assert.rejects(
    () =>
      runtime.complete({
        provider: "anthropic-main",
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    (error) => error instanceof ModelProviderError && error.error.status === 502,
  );
});

test("Authorization header strips whitespace from apiKey to avoid 'invalid_token'", async () => {
  // Defensive guard: even when a programmatic caller bypasses
  // parseModelConfig and hands in a ProviderConfig with a stray space
  // in apiKey, the wire request must still go out clean.
  const raw = validModelConfig();
  const providers = raw.providers as Record<string, any>;
  providers["openai-main"].apiKey = "sk-clean";
  const config = parseModelConfig(raw, {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  // Force a polluted apiKey post-parse to simulate a bypass.
  config.providers["openai-main"].apiKey = "  sk-whitespace  ";

  let observedAuth: string | null = null;
  const runtime = createModelRuntime(config, {
    fetch: async (_url, init) => {
      observedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "gpt-5.1",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await runtime.complete({
    provider: "openai-main",
    model: "gpt-5.1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });

  assert.equal(observedAuth, "Bearer sk-whitespace");
});

test("Anthropic x-api-key header strips whitespace from apiKey", async () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  config.providers["anthropic-main"].apiKey = " ant-pad\t";

  let observedKey: string | null = null;
  const runtime = createModelRuntime(config, {
    fetch: async (_url, init) => {
      observedKey = new Headers(init?.headers).get("x-api-key");
      return new Response(JSON.stringify({
        id: "x",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await runtime.complete({
    provider: "anthropic-main",
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });

  assert.equal(observedKey, "ant-pad");
});
