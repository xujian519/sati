import test from "node:test";
import assert from "node:assert/strict";
import { classifyAndRoute } from "../../src/router/tokenSaver/classifyAndRoute.js";
import type { RouterTokenSaverConfig } from "../../src/router/config/schema.js";
import type { CanonicalModelResponse, ModelRuntime } from "../../src/model/index.js";

function makeConfig(overrides?: Partial<RouterTokenSaverConfig>): RouterTokenSaverConfig {
  return {
    enabled: true,
    judge: { id: "p/judge", provider: "p", model: "judge" },
    defaultTier: "SIMPLE",
    tiers: {
      SIMPLE: { model: { id: "p/cheap", provider: "p", model: "cheap" } },
      COMPLEX: { model: { id: "p/expensive", provider: "p", model: "expensive" } },
    },
    judgeTimeoutMs: 5000,
    ...overrides,
  };
}

function makeJudge(responseText: string): ModelRuntime {
  return {
    stream: async function* () { throw new Error("not used"); },
    complete: async (): Promise<CanonicalModelResponse> => ({
      role: "assistant",
      content: [{ type: "text", text: responseText }],
      finishReason: "stop",
    }),
    getCapabilities: () => ({
      supportsToolUse: false,
      supportsStreaming: false,
      supportsParallelToolCalls: false,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: false,
      supportsPromptCache: false,
      maxContextTokens: 4096,
      maxOutputTokens: 256,
    }),
  };
}

function userMessages(text: string) {
  return [{ role: "user" as const, content: [{ type: "text" as const, text }] }];
}

test("classifyAndRoute returns judge-resolved tier for uppercase knownTiers", async () => {
  const result = await classifyAndRoute({
    config: makeConfig(),
    messages: userMessages("hello"),
    judgeRuntime: makeJudge("<tier>SIMPLE</tier>"),
  });
  assert.ok(result);
  assert.equal(result.tier, "SIMPLE");
  assert.equal(result.selection.model, "cheap");
  assert.equal(result.resolvedFrom, "judge");
});

test("classifyAndRoute returns defaultTier when no user message", async () => {
  const result = await classifyAndRoute({
    config: makeConfig(),
    messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
    judgeRuntime: makeJudge("unused"),
  });
  assert.ok(result);
  assert.equal(result.tier, "SIMPLE");
  assert.equal(result.resolvedFrom, "default");
});

test("classifyAndRoute returns fallback with timeout on slow judge", async () => {
  const slowJudge: ModelRuntime = {
    ...makeJudge(""),
    complete: () => new Promise((resolve) => setTimeout(() => resolve({
      role: "assistant",
      content: [{ type: "text", text: "<tier>COMPLEX</tier>" }],
      finishReason: "stop",
    }), 10_000)),
  };
  const result = await classifyAndRoute({
    config: makeConfig({ judgeTimeoutMs: 500 }),
    messages: userMessages("complex task"),
    judgeRuntime: slowJudge,
  });
  assert.ok(result);
  assert.equal(result.resolvedFrom, "fallback");
  assert.equal(result.failureReason, "timeout");
  assert.equal(result.tier, "SIMPLE");
});

test("classifyAndRoute returns parse_error when judge returns gibberish", async () => {
  const result = await classifyAndRoute({
    config: makeConfig(),
    messages: userMessages("hello"),
    judgeRuntime: makeJudge("I'm not sure what tier this is"),
  });
  assert.ok(result);
  assert.equal(result.resolvedFrom, "fallback");
  assert.equal(result.failureReason, "parse_error");
  assert.equal(result.tier, "SIMPLE");
});

test("classifyAndRoute returns model_error when judge throws", async () => {
  const errorJudge: ModelRuntime = {
    ...makeJudge(""),
    complete: async () => { throw new Error("model unavailable"); },
  };
  const result = await classifyAndRoute({
    config: makeConfig(),
    messages: userMessages("hello"),
    judgeRuntime: errorJudge,
  });
  assert.ok(result);
  assert.equal(result.resolvedFrom, "fallback");
  assert.equal(result.failureReason, "model_error");
});

test("classifyAndRoute returns undefined when disabled", async () => {
  const result = await classifyAndRoute({
    config: makeConfig({ enabled: false }),
    messages: userMessages("hello"),
    judgeRuntime: makeJudge("<tier>SIMPLE</tier>"),
  });
  assert.equal(result, undefined);
});

test("classifyAndRoute retries once when judge returns empty then succeeds", async () => {
  let callCount = 0;
  const retryJudge: ModelRuntime = {
    ...makeJudge(""),
    complete: async (): Promise<CanonicalModelResponse> => {
      callCount++;
      return {
        role: "assistant",
        content: callCount === 1
          ? [{ type: "text", text: "" }]
          : [{ type: "text", text: "<tier>COMPLEX</tier>" }],
        finishReason: "stop",
      };
    },
  };
  const result = await classifyAndRoute({
    config: makeConfig(),
    messages: userMessages("refactor the whole project"),
    judgeRuntime: retryJudge,
  });
  assert.ok(result);
  assert.equal(callCount, 2);
  assert.equal(result.tier, "COMPLEX");
  assert.equal(result.resolvedFrom, "judge");
});

test("classifyAndRoute falls back after both retry attempts return empty", async () => {
  const emptyJudge: ModelRuntime = {
    ...makeJudge(""),
    complete: async (): Promise<CanonicalModelResponse> => ({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      finishReason: "stop",
    }),
  };
  const result = await classifyAndRoute({
    config: makeConfig(),
    messages: userMessages("hello"),
    judgeRuntime: emptyJudge,
  });
  assert.ok(result);
  assert.equal(result.resolvedFrom, "fallback");
  assert.equal(result.failureReason, "parse_error");
});

test("classifyAndRoute uses last user message from multi-turn messages", async () => {
  let capturedRequest: unknown;
  const spyJudge: ModelRuntime = {
    ...makeJudge("<tier>COMPLEX</tier>"),
    complete: async (req) => {
      capturedRequest = req;
      return {
        role: "assistant",
        content: [{ type: "text", text: "<tier>COMPLEX</tier>" }],
        finishReason: "stop",
      };
    },
  };
  await classifyAndRoute({
    config: makeConfig(),
    messages: [
      { role: "user", content: [{ type: "text", text: "first question" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "refactor everything" }] },
    ],
    judgeRuntime: spyJudge,
  });
  const req = capturedRequest as { messages: Array<{ content: Array<{ text: string }> }> };
  const judgePromptText = req.messages[0].content[0].text;
  assert.ok(judgePromptText.includes("refactor everything"));
  assert.ok(!judgePromptText.includes("first question"));
});

test("classifyAndRoute forwards previousTier to judge prompt", async () => {
  let capturedRequest: unknown;
  const spyJudge: ModelRuntime = {
    ...makeJudge("<tier>COMPLEX</tier>"),
    complete: async (req) => {
      capturedRequest = req;
      return {
        role: "assistant",
        content: [{ type: "text", text: "<tier>COMPLEX</tier>" }],
        finishReason: "stop",
      };
    },
  };
  await classifyAndRoute({
    config: makeConfig(),
    messages: userMessages("继续"),
    judgeRuntime: spyJudge,
    previousTier: "COMPLEX",
  });
  const req = capturedRequest as { messages: Array<{ content: Array<{ text: string }> }> };
  const judgePromptText = req.messages[0].content[0].text;
  assert.ok(judgePromptText.includes("Previous turn was classified as: COMPLEX"));
});

test("classifyAndRoute omits previousTier from judge prompt when not provided", async () => {
  let capturedRequest: unknown;
  const spyJudge: ModelRuntime = {
    ...makeJudge("<tier>SIMPLE</tier>"),
    complete: async (req) => {
      capturedRequest = req;
      return {
        role: "assistant",
        content: [{ type: "text", text: "<tier>SIMPLE</tier>" }],
        finishReason: "stop",
      };
    },
  };
  await classifyAndRoute({
    config: makeConfig(),
    messages: userMessages("hello"),
    judgeRuntime: spyJudge,
  });
  const req = capturedRequest as { messages: Array<{ content: Array<{ text: string }> }> };
  const judgePromptText = req.messages[0].content[0].text;
  assert.ok(!judgePromptText.includes("Previous turn"));
});
