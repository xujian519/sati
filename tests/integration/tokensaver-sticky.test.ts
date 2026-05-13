import test from "node:test";
import assert from "node:assert/strict";
import { createRouterRuntime } from "../../src/router/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalModelResponse, ModelRuntime } from "../../src/model/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

function makeModelRuntime(scripts: CanonicalModelEvent[][]): ModelRuntime & { received: CanonicalModelRequest[] } {
  const received: CanonicalModelRequest[] = [];
  return {
    received,
    async *stream(request: CanonicalModelRequest) {
      received.push(request);
      const script = scripts.shift() ?? [
        { type: "message_start", role: "assistant" },
        { type: "message_end", finishReason: "stop" },
      ];
      for (const event of script) yield event;
    },
    async complete(): Promise<CanonicalModelResponse> { throw new Error("not used"); },
    getCapabilities: () => ({
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: true,
      supportsThinking: false, supportsJsonSchema: true, supportsSystemPrompt: true,
      supportsPromptCache: false, maxContextTokens: 100_000, maxOutputTokens: 4_000,
    }),
  };
}

function makeJudgeRuntime(tierSequence: string[]): ModelRuntime {
  let idx = 0;
  return {
    stream: async function* () { throw new Error("not used"); },
    complete: async (): Promise<CanonicalModelResponse> => {
      const tier = tierSequence[idx++] ?? "simple";
      return {
        role: "assistant",
        content: [{ type: "text", text: `<tier>${tier}</tier>` }],
        finishReason: "stop",
      };
    },
    getCapabilities: () => ({
      supportsToolUse: false, supportsStreaming: false, supportsParallelToolCalls: false,
      supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: false,
      supportsPromptCache: false, maxContextTokens: 4096, maxOutputTokens: 256,
    }),
  };
}

const successEvents: CanonicalModelEvent[] = [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text: "ok" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "message_end", finishReason: "stop" },
];

const baseRequest: CanonicalModelRequest = {
  provider: "ignored", model: "ignored",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

const tokenSaverConfig: RouterConfig = {
  scenarios: { default: { id: "p/default", provider: "p", model: "default" } },
  zeroUsageRetry: { enabled: false, maxAttempts: 0 },
  tokenSaver: {
    enabled: true,
    judge: { id: "p/judge", provider: "p", model: "judge" },
    defaultTier: "SIMPLE",
    tiers: {
      SIMPLE: { model: { id: "p/cheap", provider: "p", model: "cheap" } },
      COMPLEX: { model: { id: "p/expensive", provider: "p", model: "expensive" } },
    },
    judgeTimeoutMs: 5000,
  },
};

test("TokenSaver sticky: first turn calls judge, second turn reuses sticky model", async () => {
  const modelRuntime = makeModelRuntime([
    [...successEvents],
    [...successEvents],
  ]);
  const judgeRuntime = makeJudgeRuntime(["COMPLEX"]);
  const router = createRouterRuntime(tokenSaverConfig, { modelRuntime, judgeRuntime });

  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t1", isMainAgent: true })) { void _; }
  assert.equal(modelRuntime.received[0]?.model, "expensive");

  const multiTurnRequest = {
    ...baseRequest,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "reply" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
    ],
  };
  for await (const _ of router.stream(multiTurnRequest, { sessionId: "s1", turnId: "t2", isMainAgent: true })) { void _; }
  assert.equal(modelRuntime.received[1]?.model, "expensive");
});

test("TokenSaver subagent policy=skip does not invoke judge", async () => {
  const modelRuntime = makeModelRuntime([[...successEvents]]);
  let judgeCalled = false;
  const judgeRuntime: ModelRuntime = {
    stream: async function* () { throw new Error("not used"); },
    complete: async () => { judgeCalled = true; return { role: "assistant", content: [{ type: "text", text: "<tier>COMPLEX</tier>" }], finishReason: "stop" }; },
    getCapabilities: () => ({
      supportsToolUse: false, supportsStreaming: false, supportsParallelToolCalls: false,
      supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: false,
      supportsPromptCache: false, maxContextTokens: 4096, maxOutputTokens: 256,
    }),
  };
  const config: RouterConfig = {
    ...tokenSaverConfig,
    tokenSaver: { ...tokenSaverConfig.tokenSaver!, subagent: { policy: "skip" } },
  };
  const router = createRouterRuntime(config, { modelRuntime, judgeRuntime });
  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t1", isMainAgent: false })) { void _; }
  assert.equal(judgeCalled, false);
});

test("TokenSaver different sessions have independent sticky state", async () => {
  const modelRuntime = makeModelRuntime([
    [...successEvents],
    [...successEvents],
  ]);
  const judgeRuntime = makeJudgeRuntime(["COMPLEX", "SIMPLE"]);
  const router = createRouterRuntime(tokenSaverConfig, { modelRuntime, judgeRuntime });

  for await (const _ of router.stream(baseRequest, { sessionId: "session-A", turnId: "t1", isMainAgent: true })) { void _; }
  assert.equal(modelRuntime.received[0]?.model, "expensive");

  for await (const _ of router.stream(baseRequest, { sessionId: "session-B", turnId: "t1", isMainAgent: true })) { void _; }
  assert.equal(modelRuntime.received[1]?.model, "cheap");
});

test("TokenSaver subagent policy=judge classifies independently", async () => {
  const modelRuntime = makeModelRuntime([
    [...successEvents],
    [...successEvents],
  ]);
  const judgeRuntime = makeJudgeRuntime(["COMPLEX", "SIMPLE"]);
  const config: RouterConfig = {
    ...tokenSaverConfig,
    tokenSaver: { ...tokenSaverConfig.tokenSaver!, subagent: { policy: "judge" } },
  };
  const router = createRouterRuntime(config, { modelRuntime, judgeRuntime });

  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t1", isMainAgent: true })) { void _; }
  assert.equal(modelRuntime.received[0]?.model, "expensive");

  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t2", isMainAgent: false })) { void _; }
  assert.equal(modelRuntime.received[1]?.model, "cheap");
});
