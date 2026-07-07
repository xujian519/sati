import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalModelResponse, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const expensiveCached = { id: "expensive/sonnet", provider: "expensive", model: "sonnet" };
const cheaperPrefill = { id: "cheaper/gpt", provider: "cheaper", model: "gpt" };
const judge = { id: "judge/judge", provider: "judge", model: "judge" };

function createRuntime(judgeTiers: string[]): ModelRuntime {
  let index = 0;
  return {
    async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(_request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      const judgeTier = judgeTiers[Math.min(index, judgeTiers.length - 1)] ?? "sticky";
      index += 1;
      return {
        role: "assistant",
        content: [{ type: "text", text: judgeTier }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    getCapabilities() {
      return DEFAULT_MODEL_CAPABILITIES;
    },
    getMultimodal() {
      return { input: [] };
    },
    getProviderProtocol() {
      return "openai";
    },
    getProviderBaseUrl() {
      return undefined;
    },
  };
}

function createConfig(): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: expensiveCached },
    tokenSaver: {
      enabled: true,
      judge,
      defaultTier: "sticky",
      tiers: {
        sticky: { model: expensiveCached },
        cheaper: { model: cheaperPrefill },
      },
      judgeTimeoutMs: 1_000,
      cacheAwareSwitching: { enabled: true, minSavingsRatio: 0 },
    },
    stats: {
      enabled: false,
      modelPricing: {
        "expensive/sonnet": { input: 3, output: 15, cacheRead: 0.3 },
        "cheaper/gpt": { input: 2.5, output: 10 },
      },
    },
  };
}

function createRequest(text: string): CanonicalModelRequest {
  return {
    provider: "expensive",
    model: "sonnet",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text }],
      },
    ],
  };
}

test("cache-aware switching keeps sticky when cache-adjusted cost beats next prefill", async () => {
  const router = createRouterRuntime(createConfig(), { modelRuntime: createRuntime(["sticky", "cheaper"]) });
  const first = await router.decide({
    request: createRequest("seed sticky model"),
    sessionId: "cache-aware-session",
    isMainAgent: true,
  });
  assert.equal(first.provider, "expensive");
  assert.equal(first.model, "sonnet");

  router.observeUsage("cache-aware-session", {
    inputTokens: 1_000_000,
    outputTokens: 10,
    totalTokens: 1_000_010,
    cacheReadTokens: 900_000,
  });

  const stickyInfo = router.invalidateSticky("cache-aware-session");
  const second = await router.decide({
    request: createRequest("switch me if cache is ignored"),
    sessionId: "cache-aware-session",
    isMainAgent: true,
    metadata: {
      previousTier: stickyInfo.previousTier,
      previousProvider: stickyInfo.previousProvider,
      previousModel: stickyInfo.previousModel,
    },
  });

  assert.equal(second.provider, "expensive");
  assert.equal(second.model, "sonnet");
  assert.equal(second.tokenSaverTier, "sticky");
  assert.equal(second.mutations.cacheAwareSwitch?.action, "kept_sticky");
});
