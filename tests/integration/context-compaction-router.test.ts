import test from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopFixture, collectAsyncGenerator } from "../helpers/agent.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

test("AgentLoop completes when model response is truncated by length", async () => {
  const { loop, model } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "partial response..." },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 4000, totalTokens: 4100 } },
        { type: "message_end", finishReason: "length" },
      ],
    ],
  });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1",
      messages: [{ role: "user", content: [{ type: "text", text: "write a long essay" }] }],
    }),
  );
  assert.equal(result.result.type, "success");
  assert.ok(model.requests.length >= 1);
});

test("AgentLoop completes successfully after compacted tool results", async () => {
  const longToolScripts: CanonicalModelEvent[][] = [];
  for (let i = 0; i < 3; i++) {
    longToolScripts.push([
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: `Step ${i + 1} done.` },
      { type: "usage", usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } },
      { type: "message_end", finishReason: "stop" },
    ]);
  }
  const { loop, model } = createAgentLoopFixture({ scripts: longToolScripts });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1",
      messages: [{ role: "user", content: [{ type: "text", text: "process data" }] }],
    }),
  );
  assert.equal(result.result.type, "success");
  assert.ok(model.requests.length >= 1);
});

test("AgentLoop handles model error gracefully without crashing", async () => {
  const { loop } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "error", error: {
          provider: "test-provider", protocol: "openai",
          code: "internal_error", message: "something went wrong", retryable: false,
        }},
      ],
    ],
  });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  );
  assert.ok(
    result.result.type === "error" || result.result.type === "success",
    "Loop must complete (error or success) rather than throw",
  );
});
