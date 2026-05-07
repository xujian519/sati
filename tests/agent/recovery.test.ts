import test from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopFixture, collectAsyncGenerator } from "../helpers/agent.js";

test("AgentLoop classifies prompt-too-long model errors", async () => {
  const { loop } = createAgentLoopFixture({
    scripts: [
      [
        {
          type: "error",
          error: {
            provider: "test-provider",
            protocol: "anthropic",
            code: "prompt_too_long",
            message: "Prompt is too long.",
            retryable: false,
          },
        },
      ],
    ],
  });

  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
  );

  assert.equal(result.result.stopReason, "prompt_too_long");
  assert.equal(result.result.errors?.[0]?.code, "agent_prompt_too_long");
});

test("AgentLoop retries once with fallback model for retryable model errors", async () => {
  const fixture = createAgentLoopFixture({
    config: { fallbackModel: "fallback-model" },
    scripts: [
      [
        {
          type: "error",
          error: {
            provider: "test-provider",
            protocol: "anthropic",
            code: "overloaded",
            message: "Try again.",
            retryable: true,
          },
        },
      ],
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "ok" },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
  });

  const { result } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
  );

  assert.equal(result.result.type, "success");
  assert.equal(fixture.model.requests.length, 2);
  assert.equal(fixture.model.requests[1]?.model, "fallback-model");
});
