import test from "node:test";
import assert from "node:assert/strict";
import { MessageProjector } from "../../src/context/projection/MessageProjector.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const projector = new MessageProjector();

function userText(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string, name: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "tool_call", id, name, input: {} }] };
}

function userToolResult(id: string, text: string): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolCallId: id, content: [{ type: "text", text }] }],
  };
}

test("MessageProjector preserves a well-formed conversation untouched", () => {
  const messages: CanonicalMessage[] = [
    userText("hi"),
    assistantToolCall("call-1", "read_file"),
    userToolResult("call-1", "ok"),
  ];
  const result = projector.project({ messages });
  assert.deepEqual(result.messages, messages);
  assert.equal(result.droppedCount, 0);
  assert.equal(result.warnings.length, 0);
});

test("MessageProjector flags missing tool_result for an assistant tool_call", () => {
  const messages: CanonicalMessage[] = [
    userText("hi"),
    assistantToolCall("call-1", "read_file"),
    userText("ignore"),
  ];
  const result = projector.project({ messages });
  assert.ok(result.warnings.some((w) => w.code === "tool_call_unmatched"));
});

test("MessageProjector flags orphaned tool_result", () => {
  const messages: CanonicalMessage[] = [
    userText("hi"),
    userToolResult("ghost", "stale"),
  ];
  const result = projector.project({ messages });
  assert.ok(result.warnings.some((w) => w.code === "tool_result_orphaned"));
});

test("MessageProjector applies maxMessages sliding window", () => {
  const messages: CanonicalMessage[] = [
    userText("0"),
    userText("1"),
    userText("2"),
    userText("3"),
    userText("4"),
  ];
  const result = projector.project({ messages, maxMessages: 3 });
  assert.deepEqual(
    result.messages.map((m) => (m.content[0] as { text: string }).text),
    ["2", "3", "4"],
  );
  assert.equal(result.droppedCount, 2);
  assert.ok(result.warnings.some((w) => w.code === "context_truncated"));
});
