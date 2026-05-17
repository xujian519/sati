import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWebGatewayEvent,
  createWebMessageReducerState,
  type WebGatewayEvent,
  type WebMessageReducerOptions,
  type WebMessageReducerState,
} from "../../src/web/client/index.js";

function options(): WebMessageReducerOptions {
  let counter = 0;
  return {
    sessionKey: "web:test",
    projectKey: "demo",
    now: () => new Date("2026-05-09T00:00:00.000Z"),
    newId: () => `id-${++counter}`,
  };
}

function reduce(
  state: WebMessageReducerState,
  events: WebGatewayEvent[],
  opts: WebMessageReducerOptions,
): WebMessageReducerState {
  return events.reduce((acc, event) => applyWebGatewayEvent(acc, event, opts), state);
}

test("merges consecutive assistant_text_delta into a single assistant message", () => {
  const opts = options();
  const result = reduce(
    createWebMessageReducerState(),
    [
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "hello " },
      { type: "assistant_text_delta", text: "world" },
    ],
    opts,
  );
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].kind, "text");
  assert.equal(result.messages[0].role, "assistant");
  assert.equal(result.messages[0].text, "hello world");
});

test("pairs tool_call_started with tool_call_finished by toolCallId", () => {
  const opts = options();
  const result = reduce(
    createWebMessageReducerState(),
    [
      { type: "turn_started", runId: "run-1" },
      { type: "tool_call_started", toolCallId: "t1", name: "Read", argsPreview: "{path:'a'}" },
      { type: "tool_call_finished", toolCallId: "t1", ok: true, resultPreview: "ok" },
    ],
    opts,
  );
  assert.equal(result.messages.length, 1);
  const message = result.messages[0];
  assert.equal(message.kind, "tool_result");
  assert.equal(message.toolCallId, "t1");
  assert.equal(message.toolName, "Read");
  assert.equal(message.ok, true);
  assert.equal(message.text, "ok");
});

test("permission_request becomes a permission message with requestId", () => {
  const opts = options();
  const result = reduce(
    createWebMessageReducerState(),
    [
      {
        type: "permission_request",
        requestId: "req-1",
        toolName: "Bash",
        payload: { command: "rm -rf /" },
      },
    ],
    opts,
  );
  assert.equal(result.messages.length, 1);
  const message = result.messages[0];
  assert.equal(message.role, "permission");
  assert.equal(message.kind, "permission_request");
  assert.equal(message.requestId, "req-1");
  assert.equal(message.toolName, "Bash");
});

test("error event surfaces as error message and resets active assistant", () => {
  const opts = options();
  const state = reduce(
    createWebMessageReducerState(),
    [
      { type: "assistant_text_delta", text: "hi " },
      { type: "error", message: "boom", code: "X", recoverable: true },
      { type: "assistant_text_delta", text: "again" },
    ],
    opts,
  );
  // After error we expect: 1) original assistant ("hi "), 2) error, 3) NEW
  // assistant ("again") because currentAssistantId was reset.
  assert.equal(state.messages.length, 3);
  assert.deepEqual(state.messages.map((m) => m.kind), ["text", "error", "text"]);
  assert.equal(state.messages[0].text, "hi ");
  assert.equal(state.messages[2].text, "again");
});

test("turn_completed records finish reason and clears stream cursors", () => {
  const opts = options();
  const state = reduce(
    createWebMessageReducerState(),
    [
      { type: "assistant_text_delta", text: "ok" },
      { type: "turn_completed", usage: { totalTokens: 5 }, finishReason: "completed" },
    ],
    opts,
  );
  const last = state.messages.at(-1)!;
  assert.equal(last.kind, "complete");
  assert.equal(last.finishReason, "completed");
  assert.deepEqual(last.usage, { totalTokens: 5 });
  assert.equal(state.currentAssistantId, undefined);
});

test("elicitation_request → elicitation_cancelled flips message to status", () => {
  const opts = options();
  const state = reduce(
    createWebMessageReducerState(),
    [
      {
        type: "elicitation_request",
        requestId: "e1",
        toolCallId: "tc1",
        toolName: "ask_user_question",
        questions: [{ question: "?", header: "Choice", options: [{ label: "A", description: "A" }] }],
      },
      { type: "elicitation_cancelled", requestId: "e1", reason: "abort" },
    ],
    opts,
  );
  const message = state.messages.find((m) => m.requestId === "e1");
  assert.ok(message);
  assert.equal(message?.kind, "status");
});

test("ignores empty assistant_text_delta", () => {
  const opts = options();
  const state = reduce(
    createWebMessageReducerState(),
    [{ type: "assistant_text_delta", text: "" }],
    opts,
  );
  assert.equal(state.messages.length, 0);
});
