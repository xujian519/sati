import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentSession,
  collectToolCalls,
  decideLoopContinuation,
  ensureToolResultPairing,
  projectToolResults,
} from "../../src/agent/index.js";
import { createPolitDeckTestTool } from "../helpers/tool.js";
import { collectAsyncGenerator, createAgentLoopFixture } from "../helpers/agent.js";

test("loop helpers collect tool calls and project paired tool results", () => {
  const message = {
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: "Reading." },
      { type: "tool_call" as const, id: "call-1", name: "read_file", input: { filePath: "README.md" } },
    ],
  };

  const calls = collectToolCalls(message);
  const paired = ensureToolResultPairing(calls, []);
  const projected = projectToolResults(paired);

  assert.deepEqual(decideLoopContinuation(message), { type: "continue", reason: "tool_results" });
  assert.equal(calls[0]?.id, "call-1");
  assert.equal(projected.role, "user");
  assert.equal(projected.content[0]?.type, "tool_result");
});

test("AgentLoop completes a no-tool turn", async () => {
  const { loop, model } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "Done." },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
  });

  const { values, result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
  );

  assert.equal(model.requests.length, 1);
  assert.equal(result.result.type, "success");
  assert.equal(result.result.usage.totalTokens, 3);
  assert.deepEqual(
    values.map((event) => event.type),
    ["model_request_started", "model_event", "model_event", "model_event", "model_event", "assistant_message", "turn_completed"],
  );
});

test("AgentLoop executes tools and continues with canonical tool_result", async () => {
  const tool = createPolitDeckTestTool({
    name: "lookup",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string" } },
    },
    execute: async () => ({ content: [{ type: "text", text: "found" }] }),
  });
  const { loop, model } = createAgentLoopFixture({
    tools: [tool],
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "call-1", name: "lookup", input: { id: "123" } } },
        { type: "message_end", finishReason: "tool_call" },
      ],
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "The result is found." },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
  });

  const { values, result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "lookup" }] }],
      maxTurns: 3,
    }),
  );

  assert.equal(model.requests.length, 2);
  assert.equal(result.result.type, "success");
  assert.equal(model.requests[1]?.messages.at(-1)?.content[0]?.type, "tool_result");
  assert.ok(values.some((event) => event.type === "tool_calls_detected"));
  assert.ok(values.some((event) => event.type === "tool_result"));
  assert.ok(values.some((event) => event.type === "turn_continued"));
});

test("AgentLoop records permission denials and returns max_turns after tool results", async () => {
  const tool = createPolitDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { loop } = createAgentLoopFixture({
    tools: [tool],
    permissionMode: "default",
    canPrompt: false,
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "call-1", name: "write_file", input: {} } },
        { type: "message_end", finishReason: "tool_call" },
      ],
    ],
  });

  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "write" }] }],
      maxTurns: 1,
    }),
  );

  assert.equal(result.result.type, "max_turns");
  assert.equal(result.result.permissionDenials.length, 1);
  assert.equal(result.result.permissionDenials[0]?.errorCode, "permission_required");
  assert.equal(result.messages.at(-1)?.content[0]?.type, "tool_result");
});

test("TurnRunner records accepted input before model execution", async () => {
  const { turnRunner, transcript, model } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "ok" },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
  });

  const { result } = await collectAsyncGenerator(
    turnRunner.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [],
      input: { type: "text", text: "hello" },
    }),
  );

  assert.equal(result.result.type, "success");
  assert.equal(transcript.entries[0]?.type, "accepted_input");
  assert.equal(model.requests.length, 1);
  assert.equal(transcript.entries.at(-1)?.type, "turn_result");
});

test("AgentSession preserves messages across turns", async () => {
  const { turnRunner, model } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "first" },
        { type: "message_end", finishReason: "stop" },
      ],
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "second" },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
  });
  const session = new AgentSession({ sessionId: "session-1", turnRunner, uuid: () => "turn-id" });

  await collectAsyncGenerator(session.submit({ type: "text", text: "one" }, { turnId: "turn-1" }));
  await collectAsyncGenerator(session.submit({ type: "text", text: "two" }, { turnId: "turn-2" }));

  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[1]?.messages.length, 3);
  assert.equal(session.snapshot().messages.length, 4);
});
