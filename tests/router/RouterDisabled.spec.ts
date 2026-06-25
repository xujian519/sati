import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelCapabilities,
  ModelConfig,
  ModelRuntime,
  MultimodalConstraints,
} from "../../src/model/index.js";
import { parseRouterConfig } from "../../src/router/config/parseRouterConfig.js";
import { createRouterRuntime, type RouterEvent } from "../../src/router/index.js";

test("disabled router config ignores invalid nested model refs", () => {
  const result = parseRouterConfig({
    enabled: false,
    scenarios: { default: "missing/model" },
    fallback: { default: ["missing/fallback"] },
    tokenSaver: {
      enabled: true,
      judge: "missing/judge",
      tiers: {
        simple: { model: "missing/simple" },
      },
    },
    autoOrchestrate: {
      enabled: true,
      mainAgentModel: "missing/orchestrator",
      subagentModel: "missing/subagent",
    },
    stats: {
      enabled: true,
      baselineModel: "missing/baseline",
    },
  }, minimalModelConfig());

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.config, { enabled: false });
});

test("disabled router passes through the request model without judge, fallback, events, or stats", async () => {
  const runtime = fakeModelRuntime();
  const emitted: RouterEvent[] = [];
  const router = createRouterRuntime({
    enabled: false,
    scenarios: { default: ref("router", "default") },
    fallback: { default: [ref("router", "fallback")] },
    zeroUsageRetry: { enabled: true, maxAttempts: 3 },
    tokenSaver: {
      enabled: true,
      judge: ref("router", "judge"),
      defaultTier: "simple",
      tiers: {
        simple: { model: ref("router", "simple") },
      },
      judgeTimeoutMs: 1_000,
    },
    autoOrchestrate: {
      enabled: true,
      triggerTiers: ["simple"],
      slimSystemPrompt: true,
      mainAgentModel: ref("router", "orchestrator"),
      subagentModel: ref("router", "subagent"),
    },
    stats: { enabled: true },
  }, {
    modelRuntime: runtime,
    events: { emit: (event) => emitted.push(event) },
  });

  try {
    const request = textRequest();
    const decision = await router.decide({
      request,
      sessionId: "s-disabled",
      isMainAgent: true,
    });

    assert.equal(decision.provider, "main");
    assert.equal(decision.model, "agent");
    assert.equal(decision.tokenSaverTier, undefined);
    assert.equal(decision.orchestrating, false);
    assert.deepEqual(decision.mutations, {});

    const events = await collect(router.execute(decision, request, {
      sessionId: "s-disabled",
      turnId: "t-disabled",
    }));

    assert.deepEqual(runtime.completedModels, []);
    assert.deepEqual(runtime.multimodalLookups, []);
    assert.deepEqual(runtime.streamedModels, ["main/agent"]);
    assert.equal(events.some((event) => event.type === "error"), false);
    assert.deepEqual(emitted, []);
    assert.deepEqual(router.stats.recent(), []);
  } finally {
    await router.shutdown();
  }
});

test("disabled router converts thrown stream failures into canonical error events", async () => {
  const runtime = fakeModelRuntime({ throwAfterStart: true });
  const router = createRouterRuntime({
    enabled: false,
    scenarios: { default: ref("router", "default") },
    fallback: { default: [ref("router", "fallback")] },
  }, {
    modelRuntime: runtime,
  });

  try {
    const request = textRequest();
    const decision = await router.decide({
      request,
      sessionId: "s-disabled-error",
      isMainAgent: true,
    });
    const events = await collect(router.execute(decision, request, {
      sessionId: "s-disabled-error",
      turnId: "t-disabled-error",
    }));

    assert.deepEqual(events.map((event) => event.type), ["request_started", "error"]);
    const errorEvent = events[1];
    assert.ok(errorEvent && errorEvent.type === "error");
    assert.equal(errorEvent.error.provider, "main");
    assert.equal(errorEvent.error.code, "network_error");
    assert.equal(errorEvent.error.message, "fetch failed while router disabled");
    assert.deepEqual(runtime.streamedModels, ["main/agent"]);
  } finally {
    await router.shutdown();
  }
});

function ref(provider: string, model: string) {
  return { id: `${provider}/${model}`, provider, model };
}

function minimalModelConfig(): ModelConfig {
  return {
    providers: {
      main: {
        models: {
          agent: {},
        },
      },
    },
  } as unknown as ModelConfig;
}

function textRequest(messages: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
]): CanonicalModelRequest {
  return {
    provider: "main",
    model: "agent",
    messages,
    stream: true,
  };
}

async function collect(iterable: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function fakeModelRuntime(options: { throwAfterStart?: boolean } = {}): ModelRuntime & {
  completedModels: string[];
  multimodalLookups: string[];
  streamedModels: string[];
} {
  const completedModels: string[] = [];
  const multimodalLookups: string[] = [];
  const streamedModels: string[] = [];
  return {
    completedModels,
    multimodalLookups,
    streamedModels,
    async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      streamedModels.push(`${request.provider}/${request.model}`);
      yield { type: "request_started", provider: request.provider, model: request.model };
      if (options.throwAfterStart) {
        throw new Error("fetch failed while router disabled");
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
    async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      completedModels.push(`${request.provider}/${request.model}`);
      throw new Error("disabled router must not call the token saver judge");
    },
    getCapabilities(): ModelCapabilities {
      return {
        supportsToolUse: true,
        supportsStreaming: true,
        supportsParallelToolCalls: true,
        supportsThinking: false,
        supportsJsonSchema: true,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 128_000,
        maxOutputTokens: 4_096,
      };
    },
    getMultimodal(providerId: string, modelId: string): MultimodalConstraints {
      multimodalLookups.push(`${providerId}/${modelId}`);
      throw new Error("disabled router must not inspect router model multimodal metadata");
    },
    getProviderBaseUrl(): string | undefined {
      return undefined;
    },
  };
}
