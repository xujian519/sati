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
  assert.equal(result.config?.scenarios?.default.provider, "vendor-a");
  assert.equal(result.config?.scenarios?.default.model, "main");
  assert.equal(result.diagnostics.length, 0);
});

test("parseRouterConfig flags unknown provider in default scenario", () => {
  const result = parseRouterConfig(
    { scenarios: { default: "missing/main" } },
    modelConfig,
  );
  // We still surface the malformed ref as a fatal diagnostic — the
  // top-level `loadPilotConfig` runs `throwConfigErrorIfFatal` on the
  // accumulated diagnostics, so the gateway never sees this partial config.
  // We *don't* require `result.config === undefined` anymore: missing /
  // invalid scenarios are also the "user has partial yaml" path and that
  // path returns a populated config so `ensureRouterConfig` can fill
  // `scenarios.default` from `agent.model` for soft failures.
  assert.equal(result.config?.scenarios, undefined);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ROUTER_REF_PROVIDER_NOT_FOUND" && diagnostic.severity === "fatal",
    ),
  );
});

test("parseRouterConfig allows partial router (missing scenarios) for ensureRouterConfig to fill in", () => {
  // Mirrors the real-world UI persistence pattern that revealed the bug:
  // user toggles `router.enabled=true` and seeds tokenSaver tiers but
  // never opens the Scenarios editor. We must keep the rest of the config
  // (no fatal) so createLocalGateway's `ensureRouterConfig` can derive
  // `scenarios.default` from `agent.model`.
  const result = parseRouterConfig(
    {
      enabled: true,
      tokenSaver: {
        enabled: true,
        judge: "vendor-a/main",
        defaultTier: "medium",
        tiers: { medium: { model: "vendor-a/main", description: "default tier" } },
        rules: [],
        judgeTimeoutMs: 15000,
      },
    },
    modelConfig,
  );
  assert.ok(result.config, "config should not be dropped just because scenarios is absent");
  assert.equal(result.config?.scenarios, undefined);
  assert.ok(result.config?.tokenSaver, "tokenSaver should survive missing scenarios");
  assert.equal(
    result.diagnostics.filter((d) => d.severity === "fatal").length,
    0,
    "no fatal diagnostic for the partial-router-from-UI case",
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

test("parseRouterConfig parses stats baseline model", () => {
  const result = parseRouterConfig(
    {
      scenarios: { default: "vendor-a/main" },
      stats: {
        enabled: true,
        baselineModel: "vendor-a/main",
        modelPricing: {
          "vendor-a/budget": { input: 0.1, output: 0.2, cacheRead: 0.01 },
        },
      },
    },
    modelConfig,
  );
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.severity === "fatal").length, 0);
  assert.equal(result.config?.stats?.baselineModel?.provider, "vendor-a");
  assert.equal(result.config?.stats?.baselineModel?.model, "main");
  assert.deepEqual(result.config?.stats?.modelPricing?.["vendor-a/budget"], {
    input: 0.1,
    output: 0.2,
    cacheRead: 0.01,
  });
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
