import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentLoop,
  AgentSession,
  collectToolCalls,
  decideLoopContinuation,
  ensureToolResultPairing,
  projectToolResults,
} from "../../src/agent/index.js";
import { createEnterPlanModeTool, createStructuredOutputTool } from "../../src/tool/index.js";
import { createPilotDeckTestTool } from "../helpers/tool.js";
import { collectAsyncGenerator, createAgentLoopFixture } from "../helpers/agent.js";

test("loop helpers collect tool calls and project paired tool results", () => {
  const message = {
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: "Reading." },
      { type: "tool_call" as const, id: "call-1", name: "read_file", input: { file_path: "README.md" } },
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
    ["model_request_started", "model_event", "model_event", "model_event", "model_event", "assistant_message", "stop_requested", "turn_completed"],
  );
});

test("AgentLoop emits a context_budget snapshot before model execution", async () => {
  const { model, config, dependencies } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "Done." },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
  });
  const budgetLoop = new AgentLoop(config, {
    ...dependencies,
    context: {
      async prepareForModel() {
        return {
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          systemPrompt: "",
          systemPromptParts: [],
          tools: [],
          diagnostics: [],
          boundaries: [],
        };
      },
      async applyToolResults() {
        return {
          messages: [],
          diagnostics: [],
        };
      },
      async recoverFromModelError() {
        return {
          type: "give_up" as const,
          reason: "unused",
        };
      },
      async tryAutoCompact() {
        return {
          type: "skipped" as const,
          snapshot: {
            tokens: 1234,
            maxContextTokens: 16000,
            warningRatio: 0.8,
            blockingRatio: 0.95,
            state: "ok" as const,
            ratio: 1234 / 16000,
          },
        };
      },
    },
  });

  const { values } = await collectAsyncGenerator(
    budgetLoop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
  );

  assert.equal(model.requests.length, 1);
  const budgetEventIndex = values.findIndex((event) => event.type === "context_budget");
  const modelStartIndex = values.findIndex((event) => event.type === "model_request_started");
  assert.ok(budgetEventIndex >= 0, "should emit context_budget");
  assert.ok(modelStartIndex >= 0, "should emit model_request_started");
  assert.ok(budgetEventIndex < modelStartIndex, "context_budget should be emitted before model_request_started");
  const budgetEvent = values[budgetEventIndex] as Extract<(typeof values)[number], { type: "context_budget" }>;
  assert.equal(budgetEvent.snapshot.tokens, 1234);
  assert.equal(budgetEvent.snapshot.maxContextTokens, 16000);
});

test("AgentLoop stops before model request when abort fires during prepareForModel", async () => {
  const { model, config, dependencies } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "should not run" },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
  });
  const controller = new AbortController();
  const loop = new AgentLoop(config, {
    ...dependencies,
    context: {
      async prepareForModel() {
        controller.abort();
        return {
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          systemPrompt: "",
          systemPromptParts: [],
          tools: [],
          diagnostics: [],
          boundaries: [],
        };
      },
      async applyToolResults() {
        return { messages: [], diagnostics: [] };
      },
      async recoverFromModelError() {
        return { type: "give_up" as const, reason: "unused" };
      },
    },
  });

  const { values, result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      abortSignal: controller.signal,
    }),
  );

  assert.equal(model.requests.length, 0);
  assert.equal(result.result.type, "aborted");
  assert.deepEqual(values.map((event) => event.type), ["turn_completed"]);
});

test("AgentLoop executes tools and continues with canonical tool_result", async () => {
  const tool = createPilotDeckTestTool({
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
  const tool = createPilotDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
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

test("AgentLoop captures structured output and can stop after the tool result", async () => {
  const { loop, config } = createAgentLoopFixture({
    tools: [createStructuredOutputTool()],
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        {
          type: "tool_call_end",
          toolCall: { id: "call-1", name: "structured_output", input: { value: { ok: true } } },
        },
        { type: "message_end", finishReason: "tool_call" },
      ],
    ],
  });
  config.stopOnStructuredOutput = true;

  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "json" }] }],
    }),
  );

  assert.deepEqual(result.result.structuredOutput, { ok: true });
  assert.equal(result.result.type, "success");
});

test("AgentLoop does not self-correct invalid_tool_arguments when jsonSelfCorrect is false", async () => {
  const { loop, model } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        {
          type: "error",
          error: {
            provider: "test",
            protocol: "openai",
            code: "invalid_tool_arguments",
            message: "Bad JSON",
            retryable: false,
          },
        },
      ],
    ],
    config: { jsonSelfCorrect: false },
  });

  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "use a tool" }] }],
    }),
  );

  assert.equal(model.requests.length, 1, "should NOT retry with a self-correct message");
  assert.equal(result.result.type, "error");
});

test("AgentLoop self-corrects invalid_tool_arguments when jsonSelfCorrect is true", async () => {
  const { loop, model } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        {
          type: "error",
          error: {
            provider: "test",
            protocol: "openai",
            code: "invalid_tool_arguments",
            message: "Bad JSON",
            retryable: false,
          },
        },
      ],
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "Fixed." },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
        { type: "message_end", finishReason: "stop" },
      ],
    ],
    config: { jsonSelfCorrect: true },
  });

  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "use a tool" }] }],
    }),
  );

  assert.equal(model.requests.length, 2, "should retry after injecting self-correct message");
  assert.equal(result.result.type, "success");
  const lastReqMessages = model.requests[1].messages;
  const syntheticMsg = lastReqMessages.find(
    (m: any) => m.metadata?.synthetic === true,
  );
  assert.ok(syntheticMsg, "should have a synthetic self-correct message in the retry request");
});

test("AgentLoop consumes requested plan mode changes from plan tools", async () => {
  const fixture = createAgentLoopFixture({
    tools: [createEnterPlanModeTool()],
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "call-1", name: "enter_plan_mode", input: {} } },
        { type: "message_end", finishReason: "tool_call" },
      ],
    ],
  });

  const { values } = await collectAsyncGenerator(
    fixture.loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "plan" }] }],
      maxTurns: 1,
    }),
  );

  assert.equal(fixture.config.permissionMode, "plan");
  assert.equal(fixture.config.permissionContext.mode, "plan");
  assert.ok(values.some((event) => event.type === "mode_change_requested"));
});
