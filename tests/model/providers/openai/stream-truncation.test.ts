import test from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
} from "../../../../src/model/providers/openai/stream.js";
import { ModelProviderError } from "../../../../src/model/protocol/errors.js";

function emitToolCallDelta(
  state: ReturnType<typeof createOpenAIStreamState>,
  opts: { id: string; name: string; args: string },
) {
  return normalizeOpenAIStreamEvent(
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: opts.id,
            type: "function",
            function: { name: opts.name, arguments: opts.args },
          }],
        },
      }],
    },
    state,
  );
}

function emitFinish(
  state: ReturnType<typeof createOpenAIStreamState>,
  finishReason: string,
) {
  return normalizeOpenAIStreamEvent(
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    state,
  );
}

test("JSON parse failure + finish_reason=length → max_output_reached", () => {
  const state = createOpenAIStreamState();

  // "{{{{" cannot be repaired by jsonrepair
  emitToolCallDelta(state, { id: "call_1", name: "write_file", args: "{{{{" });

  assert.throws(
    () => emitFinish(state, "length"),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.strictEqual(err.error.code, "max_output_reached");
      return true;
    },
  );
});

test("JSON parse failure + finish_reason=stop → invalid_tool_arguments", () => {
  const state = createOpenAIStreamState();

  emitToolCallDelta(state, { id: "call_2", name: "bash", args: "{{{{" });

  assert.throws(
    () => emitFinish(state, "stop"),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.strictEqual(err.error.code, "invalid_tool_arguments");
      return true;
    },
  );
});

test("jsonrepair-success + finish_reason=length → max_output_reached (repaired-but-truncated)", () => {
  const state = createOpenAIStreamState();

  // Missing closing brace — jsonrepair repairs this, but finishReason=length
  // means the content is likely truncated
  emitToolCallDelta(state, { id: "call_3", name: "write_file", args: '{"file_path":"a.txt","content":"hello"' });

  assert.throws(
    () => emitFinish(state, "length"),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.strictEqual(err.error.code, "max_output_reached");
      return true;
    },
  );
});

test("valid JSON tool call emits tool_call_end normally", () => {
  const state = createOpenAIStreamState();

  emitToolCallDelta(state, { id: "call_4", name: "bash", args: '{"command":"ls -la"}' });

  const events = emitFinish(state, "stop");

  const toolCallEnd = events.find((e) => e.type === "tool_call_end");
  assert.ok(toolCallEnd, "should emit tool_call_end");
  if (toolCallEnd.type === "tool_call_end") {
    assert.deepStrictEqual(toolCallEnd.toolCall.input, { command: "ls -la" });
    assert.strictEqual(toolCallEnd.wasRepaired, false);
  }
});

test("jsonrepair-success + finish_reason=stop → normal tool_call_end (wasRepaired=true)", () => {
  const state = createOpenAIStreamState();

  // Missing brace repaired, but finish_reason=stop means not truncated
  emitToolCallDelta(state, { id: "call_5", name: "bash", args: '{"command":"echo hi"' });

  const events = emitFinish(state, "stop");

  const toolCallEnd = events.find((e) => e.type === "tool_call_end");
  assert.ok(toolCallEnd, "should emit tool_call_end");
  if (toolCallEnd.type === "tool_call_end") {
    assert.strictEqual(toolCallEnd.wasRepaired, true);
    assert.deepStrictEqual(toolCallEnd.toolCall.input, { command: "echo hi" });
  }
});
