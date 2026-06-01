import test from "node:test";
import assert from "node:assert/strict";

import {
  createAnthropicStreamState,
  normalizeAnthropicStreamEvent,
} from "../../../../src/model/providers/anthropic/stream.js";

function emitToolCallSequence(
  state: ReturnType<typeof createAnthropicStreamState>,
  opts: { id: string; name: string; args: string },
) {
  normalizeAnthropicStreamEvent(
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: opts.id, name: opts.name } },
    state,
  );
  normalizeAnthropicStreamEvent(
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: opts.args } },
    state,
  );
  return normalizeAnthropicStreamEvent(
    { type: "content_block_stop", index: 0 },
    state,
  );
}

test("JSON parse failure deferred until finishReason=length → max_output_reached", () => {
  const state = createAnthropicStreamState();

  // "{{{{" cannot be repaired by jsonrepair
  const stopEvents = emitToolCallSequence(state, { id: "tc_1", name: "write_file", args: "{{{{" });
  assert.deepStrictEqual(stopEvents, [], "content_block_stop should produce no events (deferred)");
  assert.strictEqual(state.failedToolCalls.length, 1, "should have 1 deferred failure");

  const deltaEvents = normalizeAnthropicStreamEvent(
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 100 } },
    state,
  );

  const errorEvent = deltaEvents.find((e) => e.type === "error");
  assert.ok(errorEvent, "should emit an error event");
  if (errorEvent.type === "error") {
    assert.strictEqual(errorEvent.error.code, "max_output_reached");
  }

  const endEvent = deltaEvents.find((e) => e.type === "message_end");
  assert.ok(endEvent, "should emit message_end");
  if (endEvent.type === "message_end") {
    assert.strictEqual(endEvent.finishReason, "length");
  }
});

test("JSON parse failure + stop_reason=end_turn → invalid_tool_arguments", () => {
  const state = createAnthropicStreamState();

  const stopEvents = emitToolCallSequence(state, { id: "tc_2", name: "bash", args: "{{{{" });
  assert.deepStrictEqual(stopEvents, []);
  assert.strictEqual(state.failedToolCalls.length, 1);

  const deltaEvents = normalizeAnthropicStreamEvent(
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
    state,
  );

  const errorEvent = deltaEvents.find((e) => e.type === "error");
  assert.ok(errorEvent);
  if (errorEvent.type === "error") {
    assert.strictEqual(errorEvent.error.code, "invalid_tool_arguments");
  }
});

test("valid JSON tool call emits tool_call_end normally", () => {
  const state = createAnthropicStreamState();

  const stopEvents = emitToolCallSequence(state, {
    id: "tc_3",
    name: "bash",
    args: '{"command":"ls -la"}',
  });
  assert.strictEqual(stopEvents.length, 1);
  assert.strictEqual(stopEvents[0]!.type, "tool_call_end");
  if (stopEvents[0]!.type === "tool_call_end") {
    assert.strictEqual(stopEvents[0]!.wasRepaired, false);
  }
  assert.strictEqual(state.failedToolCalls.length, 0, "no deferred failures");
});

test("jsonrepair-success marks wasRepaired=true on tool_call_end", () => {
  const state = createAnthropicStreamState();

  // Missing closing brace — jsonrepair repairs this
  const stopEvents = emitToolCallSequence(state, {
    id: "tc_4",
    name: "write_file",
    args: '{"file_path":"a.txt","content":"hello"',
  });
  assert.strictEqual(stopEvents.length, 1);
  const event = stopEvents[0]!;
  assert.strictEqual(event.type, "tool_call_end");
  if (event.type === "tool_call_end") {
    assert.strictEqual(event.wasRepaired, true);
  }
});

test("message_stop flushes deferred failures as safety net", () => {
  const state = createAnthropicStreamState();

  emitToolCallSequence(state, { id: "tc_5", name: "bash", args: "{{{{" });
  assert.strictEqual(state.failedToolCalls.length, 1);

  const stopEvents = normalizeAnthropicStreamEvent(
    { type: "message_stop" },
    state,
  );

  const errorEvent = stopEvents.find((e) => e.type === "error");
  assert.ok(errorEvent, "message_stop should flush deferred failures");
  if (errorEvent.type === "error") {
    assert.strictEqual(errorEvent.error.code, "invalid_tool_arguments");
  }
});

test("no deferred failures → message_delta produces no error event", () => {
  const state = createAnthropicStreamState();

  emitToolCallSequence(state, {
    id: "tc_6",
    name: "bash",
    args: '{"command":"echo hi"}',
  });

  const deltaEvents = normalizeAnthropicStreamEvent(
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    state,
  );

  const errorEvent = deltaEvents.find((e) => e.type === "error");
  assert.strictEqual(errorEvent, undefined, "no error event when all tool calls parsed fine");
});
