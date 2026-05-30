import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalModelError,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig, RouterModelRef } from "../../src/router/config/schema.js";
import type {
  TelemetryClient,
  TelemetryErrorInput,
  TelemetryFeatureUsedInput,
} from "../../src/telemetry/index.js";

const mainModel: RouterModelRef = {
  id: "openai/gpt-main",
  provider: "openai",
  model: "gpt-main",
};

const fallbackModel: RouterModelRef = {
  id: "anthropic/claude-fallback",
  provider: "anthropic",
  model: "claude-fallback",
};

function request(): CanonicalModelRequest {
  return {
    provider: mainModel.provider,
    model: mainModel.model,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: true,
  };
}

function createTelemetryRecorder(): TelemetryClient & {
  features: TelemetryFeatureUsedInput[];
  errors: TelemetryErrorInput[];
} {
  return {
    features: [],
    errors: [],
    track: () => undefined,
    trackFeatureUsed(input) {
      this.features.push(input);
    },
    trackFeatureLoopStage(input) {
      this.features.push(input);
    },
    trackError(_error, input) {
      if (input) {
        this.errors.push(input);
      }
    },
    flush: async () => undefined,
    shutdown: async () => undefined,
    snapshot: () => ({
      queued: 0,
      sent: 0,
      dropped: 0,
      sendFailures: 0,
      retries: 0,
      queueDepth: 0,
    }),
    getConfig: () => ({
      enabled: true,
      baseUrl: "http://example.test",
      batchSize: 10,
      flushIntervalMs: 60_000,
      timeoutMs: 1_000,
      maxRetries: 1,
      maxQueueSize: 100,
      queueFilePath: "/tmp/pilotdeck-telemetry-test.jsonl",
    }),
  };
}

function createRuntime(overrides: Partial<ModelRuntime> = {}): ModelRuntime {
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      return {
        role: "assistant",
        content: [{ type: "text", text: "simple" }],
        finishReason: "stop",
      };
    },
    getCapabilities: () => ({ supportsTools: true, supportsThinking: false }),
    getMultimodal: () => ({ input: [] }),
    getProviderBaseUrl: () => undefined,
    ...overrides,
  } as ModelRuntime;
}

function baseConfig(extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    scenarios: { default: mainModel },
    stats: { enabled: false },
    ...extra,
  };
}

test("router decide does not emit decision telemetry when tokenSaver is inactive", async () => {
  const telemetry = createTelemetryRecorder();
  const router = createRouterRuntime(baseConfig(), {
    modelRuntime: createRuntime(),
    telemetry,
  });

  await router.decide({
    request: request(),
    sessionId: "session-1",
    isMainAgent: true,
  });

  assert.equal(telemetry.features.length, 0);
  await router.shutdown();
});

test("router judge telemetry is still emitted when tokenSaver participates", async () => {
  const telemetry = createTelemetryRecorder();
  const router = createRouterRuntime(
    baseConfig({
      tokenSaver: {
        enabled: true,
        judge: mainModel,
        defaultTier: "simple",
        judgeTimeoutMs: 1_000,
        tiers: { simple: { model: mainModel } },
      },
    }),
    {
      modelRuntime: createRuntime(),
      judgeRuntime: createRuntime(),
      telemetry,
    },
  );

  await router.decide({
    request: request(),
    sessionId: "session-2",
    isMainAgent: true,
  });

  assert.ok(
    telemetry.features.some(
      (event) =>
        event.module === "router" &&
        event.executionKind === "router_judge" &&
        event.phase === "judge",
    ),
  );
  assert.equal(
    telemetry.features.some((event) => event.phase === "decision"),
    false,
  );
  await router.shutdown();
});

test("router fallback telemetry is preserved", async () => {
  const telemetry = createTelemetryRecorder();
  const retryableError: CanonicalModelError = {
    provider: mainModel.provider,
    protocol: "openai",
    code: "server_error",
    message: "temporary failure",
    retryable: true,
  };
  let call = 0;
  const router = createRouterRuntime(
    baseConfig({
      fallback: { default: [fallbackModel] },
      transientRetry: { enabled: false, maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
    }),
    {
      modelRuntime: createRuntime({
        async *stream(): AsyncIterable<CanonicalModelEvent> {
          call += 1;
          if (call === 1) {
            yield { type: "error", error: retryableError };
            return;
          }
          yield { type: "message_start", role: "assistant" };
          yield { type: "text_delta", text: "ok" };
          yield { type: "message_end", finishReason: "stop" };
        },
      }),
      telemetry,
    },
  );

  const decision = await router.decide({
    request: request(),
    sessionId: "session-3",
    isMainAgent: true,
  });
  for await (const _event of router.execute(decision, request(), {
    sessionId: "session-3",
    turnId: "turn-1",
  })) {
    // Drain the stream so fallback handling runs.
  }

  assert.ok(
    telemetry.features.some(
      (event) =>
        event.module === "router" &&
        event.ownerModule === "router" &&
        event.phase === "fallback",
    ),
  );
  await router.shutdown();
});
