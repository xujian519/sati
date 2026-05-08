import test from "node:test";
import assert from "node:assert/strict";
import { collectAsyncGenerator, createAgentLoopFixture } from "../helpers/agent.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

const maxOutputReached = (): CanonicalModelEvent[] => [
  { type: "message_start", role: "assistant" },
  {
    type: "error",
    error: {
      provider: "openai",
      protocol: "openai",
      code: "max_output_reached",
      message: "Maximum output tokens reached",
      retryable: false,
    },
  },
];

const successReply = (text: string): CanonicalModelEvent[] => [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text },
  { type: "message_end", finishReason: "stop" },
];

test("AgentLoop output-token recovery: max_output_reached → bump tokens and retry once", async () => {
  const fixture = createAgentLoopFixture({
    scripts: [maxOutputReached(), successReply("recovered")],
    config: { maxOutputTokens: 1024 },
  });

  const { values, result } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  );

  assert.equal(result.result.type, "success");
  assert.equal(fixture.model.requests.length, 2);
  // Second request should request more output tokens than the first.
  assert.ok(
    (fixture.model.requests[1]!.maxOutputTokens ?? 0) > (fixture.model.requests[0]!.maxOutputTokens ?? 0),
  );
  assert.equal(fixture.model.requests[1]!.maxOutputTokens, 2048);
  // turn_continued event with model_error reason should fire.
  assert.ok(
    values.some((event) => event.type === "turn_continued" && event.reason === "model_error"),
  );
});

test("AgentLoop output-token recovery: second max_output_reached falls through to fail", async () => {
  const fixture = createAgentLoopFixture({
    scripts: [maxOutputReached(), maxOutputReached()],
    config: { maxOutputTokens: 1024 },
  });

  const { result } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  );

  assert.equal(result.result.type, "error");
  assert.equal(result.result.stopReason, "model_error");
  assert.equal(fixture.model.requests.length, 2);
});

test("AgentLoop output-token recovery: caps maxOutputTokens at retry ceiling", async () => {
  const fixture = createAgentLoopFixture({
    scripts: [maxOutputReached(), successReply("ok")],
    config: { maxOutputTokens: 50_000 },
  });

  await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  );

  // 50_000 * 2 = 100_000 → capped at OUTPUT_TOKEN_RETRY_CEILING (64_000).
  assert.equal(fixture.model.requests[1]!.maxOutputTokens, 64_000);
});

test("AgentLoop output-token recovery uses default budget when none configured", async () => {
  const fixture = createAgentLoopFixture({
    scripts: [maxOutputReached(), successReply("ok")],
  });

  await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "s",
      turnId: "t",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  );

  // No maxOutputTokens configured → default 4096 → bumped to 8192.
  assert.equal(fixture.model.requests[1]!.maxOutputTokens, 8192);
});
