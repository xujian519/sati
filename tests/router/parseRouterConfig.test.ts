import test from "node:test";
import assert from "node:assert/strict";
import { parseRouterConfig } from "../../src/router/config/parseRouterConfig.js";
import type { ModelConfig } from "../../src/model/index.js";

const modelConfig: ModelConfig = {
  providers: {
    "vendor-a": {
      id: "vendor-a",
      protocol: "anthropic",
      url: "https://example.test",
      apiKey: "ak",
      headers: {},
      models: {
        main: {
          id: "main",
          capabilities: {
            supportsToolUse: true,
            supportsStreaming: true,
            supportsParallelToolCalls: true,
            supportsThinking: false,
            supportsJsonSchema: true,
            supportsSystemPrompt: true,
            supportsPromptCache: false,
            maxContextTokens: 200_000,
            maxOutputTokens: 8_000,
          },
          multimodal: { input: ["text"] },
        },
        budget: {
          id: "budget",
          capabilities: {
            supportsToolUse: true,
            supportsStreaming: true,
            supportsParallelToolCalls: true,
            supportsThinking: false,
            supportsJsonSchema: true,
            supportsSystemPrompt: true,
            supportsPromptCache: false,
            maxContextTokens: 100_000,
            maxOutputTokens: 4_000,
          },
          multimodal: { input: ["text"] },
        },
      },
    },
  },
};

test("parseRouterConfig returns undefined when input is undefined", () => {
  const result = parseRouterConfig(undefined, modelConfig);
  assert.equal(result.config, undefined);
  assert.equal(result.diagnostics.length, 0);
});

test("parseRouterConfig validates default scenario provider/model", () => {
  const result = parseRouterConfig(
    { scenarios: { default: "vendor-a/main" } },
    modelConfig,
  );
  assert.ok(result.config);
  assert.equal(result.config?.scenarios.default.provider, "vendor-a");
  assert.equal(result.config?.scenarios.default.model, "main");
  assert.equal(result.diagnostics.length, 0);
});

test("parseRouterConfig flags unknown provider in default scenario", () => {
  const result = parseRouterConfig(
    { scenarios: { default: "missing/main" } },
    modelConfig,
  );
  assert.equal(result.config, undefined);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "ROUTER_REF_PROVIDER_NOT_FOUND"),
  );
});

test("parseRouterConfig validates fallback list", () => {
  const result = parseRouterConfig(
    {
      scenarios: { default: "vendor-a/main" },
      fallback: { default: ["vendor-a/budget"] },
    },
    modelConfig,
  );
  assert.equal(result.config?.fallback?.default?.[0]?.model, "budget");
});

test("parseRouterConfig defaults zeroUsageRetry to enabled with 2 attempts", () => {
  const result = parseRouterConfig({ scenarios: { default: "vendor-a/main" } }, modelConfig);
  assert.deepEqual(result.config?.zeroUsageRetry, { enabled: true, maxAttempts: 2 });
});

test("parseRouterConfig validates tokenSaver tiers", () => {
  const result = parseRouterConfig(
    {
      scenarios: { default: "vendor-a/main" },
      tokenSaver: {
        enabled: true,
        judge: "vendor-a/budget",
        defaultTier: "fast",
        tiers: {
          fast: { model: "vendor-a/budget", description: "cheap" },
          smart: { model: "vendor-a/main" },
        },
      },
    },
    modelConfig,
  );
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.severity === "fatal").length, 0);
  assert.equal(result.config?.tokenSaver?.tiers["fast"]?.model.model, "budget");
  assert.equal(result.config?.tokenSaver?.tiers["smart"]?.model.model, "main");
});

test("parseRouterConfig fails when defaultTier is unknown", () => {
  const result = parseRouterConfig(
    {
      scenarios: { default: "vendor-a/main" },
      tokenSaver: {
        enabled: true,
        judge: "vendor-a/budget",
        defaultTier: "missing",
        tiers: { fast: { model: "vendor-a/budget" } },
      },
    },
    modelConfig,
  );
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "ROUTER_TOKEN_SAVER_DEFAULT_TIER_UNKNOWN"),
  );
});
