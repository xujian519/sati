import test from "node:test";
import assert from "node:assert/strict";
import { collectAsyncGenerator, createAgentLoopFixture } from "../helpers/agent.js";
import type {
  AgentContextRuntime,
  AgentContextRecoveryInput,
} from "../../src/context/ContextRuntime.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";
import type { ContextRecoveryDecision } from "../../src/context/index.js";

/** Light-weight stub that mirrors the agent-facing context contract. */
function stubContextRuntime(
  recover: (input: AgentContextRecoveryInput) => Promise<ContextRecoveryDecision>,
): AgentContextRuntime {
  return {
    prepareForModel: async (input) => ({
      messages: input.messages,
      tools: input.tools,
      boundaries: [],
      diagnostics: [],
    }),
    recoverFromModelError: recover,
  };
}

const promptTooLong = (): CanonicalModelEvent[] => [
  { type: "message_start", role: "assistant" },
  {
    type: "error",
    error: {
      provider: "anthropic",
      protocol: "anthropic",
      code: "prompt_too_long",
      message: "Prompt is too long: 250000 tokens > 200000 maximum",
      retryable: false,
      recoverableViaCompact: true,
    },
  },
];

const successReply = (text: string): CanonicalModelEvent[] => [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text },
  { type: "message_end", finishReason: "stop" },
];

test("AgentLoop reactive recovery: PTL → truncate head and retry, then succeed", async () => {
  const fixture = createAgentLoopFixture({
    scripts: [promptTooLong(), successReply("recovered")],
  });
  let attempt = 0;
  fixture.dependencies.context = stubContextRuntime(async () => {
    attempt += 1;
    return { type: "truncate_head_and_retry", keepRatio: 0.5, reason: `ptl-${attempt}` };
  });

  const longHistory = Array.from({ length: 10 }, (_, i) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text: `m${i}` }],
  }));

  const { values, result } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: longHistory,
    }),
  );

  assert.equal(result.result.type, "success");
  // Two model requests: first failed PTL, second succeeded after truncation.
  assert.equal(fixture.model.requests.length, 2);
  // Second request must have fewer messages than the first (head truncated).
  assert.ok(
    fixture.model.requests[1]!.messages.length < fixture.model.requests[0]!.messages.length,
    `Expected truncated retry to send fewer messages (got ${fixture.model.requests[1]!.messages.length} vs ${fixture.model.requests[0]!.messages.length}).`,
  );
  // Loop emits a turn_continued event with reason "model_error" between the two requests.
  const continuedEvents = values.filter((event) => event.type === "turn_continued");
  assert.ok(continuedEvents.some((event) => event.type === "turn_continued" && event.reason === "model_error"));
});

test("AgentLoop reactive recovery: second PTL within same turn falls through to fail", async () => {
  const fixture = createAgentLoopFixture({
    scripts: [promptTooLong(), promptTooLong()],
  });
  fixture.dependencies.context = stubContextRuntime(async (input) =>
    input.hasAttemptedCompact
      ? { type: "give_up", reason: "ptl-second-attempt" }
      : { type: "truncate_head_and_retry", keepRatio: 0.5, reason: "ptl-first" },
  );

  const longHistory = Array.from({ length: 8 }, (_, i) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text: `m${i}` }],
  }));

  const { result } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: longHistory,
    }),
  );

  // First PTL → truncate (give_up returns false → reactive truncate). Second
  // PTL → context returns give_up → AgentRecoveryPolicy classifies PTL → fail
  // with stopReason "prompt_too_long". Decision §3.1 #8 single-shot.
  assert.equal(result.result.type, "error");
  assert.equal(result.result.stopReason, "prompt_too_long");
  assert.equal(fixture.model.requests.length, 2);
});

test("AgentLoop reactive recovery is skipped when context runtime has no recoverFromModelError", async () => {
  const fixture = createAgentLoopFixture({
    scripts: [promptTooLong()],
  });
  // Default fixture context is undefined; explicitly leave it undefined so the
  // loop must fall back to the AgentRecoveryPolicy path directly.
  fixture.dependencies.context = undefined;

  const { result } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  );

  assert.equal(result.result.type, "error");
  // Without reactive recovery, only one model request is sent.
  assert.equal(fixture.model.requests.length, 1);
});

test("AgentLoop reactive recovery: non-PTL errors do not trigger truncate path", async () => {
  const customDecisions: ContextRecoveryDecision[] = [];
  const ctx: AgentContextRuntime = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      tools: input.tools,
      boundaries: [],
      diagnostics: [],
    }),
    recoverFromModelError: async (input: AgentContextRecoveryInput) => {
      const decision: ContextRecoveryDecision = { type: "give_up", reason: `not-ptl:${input.error.code}` };
      customDecisions.push(decision);
      return decision;
    },
  };
  const fixture = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        {
          type: "error",
          error: {
            provider: "anthropic",
            protocol: "anthropic",
            code: "rate_limit_error",
            message: "rate limit",
            retryable: false,
          },
        },
      ],
    ],
  });
  fixture.dependencies.context = ctx;

  const { result } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  );

  assert.equal(result.result.type, "error");
  // recoverFromModelError was consulted exactly once (the loop probes regardless of code).
  assert.equal(customDecisions.length, 1);
  assert.equal(customDecisions[0]?.type, "give_up");
  assert.equal(fixture.model.requests.length, 1);
});

test("AgentLoop reactive recovery: keepRatio actually slices messages", async () => {
  // Capture the second request's messages and verify keepRatio=0.5 effectively
  // halves the original count.
  const fixture = createAgentLoopFixture({
    scripts: [promptTooLong(), successReply("ok")],
  });
  fixture.dependencies.context = stubContextRuntime(async () => ({
    type: "truncate_head_and_retry",
    keepRatio: 0.5,
    reason: "test",
  }));

  const longHistory = Array.from({ length: 12 }, (_, i) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text: `m${i}` }],
  }));

  await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: longHistory,
    }),
  );

  const second = fixture.model.requests[1]!;
  // Original 12 → keepRatio 0.5 → keep 6.
  assert.equal(second.messages.length, 6);
  assert.equal((second.messages[0]?.content[0] as { text: string }).text, "m6");
});
