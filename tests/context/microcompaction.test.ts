import test from "node:test";
import assert from "node:assert/strict";
import { MicroCompactionEngine, MICROCOMPACT_CLEARED } from "../../src/context/compaction/MicroCompactionEngine.js";
import type { CanonicalMessage } from "../../src/model/index.js";

function assistantToolCall(id: string, name: string): CanonicalMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, input: {} }],
  };
}

function toolResult(id: string, size: number): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolCallId: id, content: [{ type: "text", text: "x".repeat(size) }] }],
  };
}

function toolResultWithImage(id: string, base64Size: number): CanonicalMessage {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: id,
      content: [{ type: "image", source: "base64", data: "a".repeat(base64Size), mimeType: "image/jpeg" }],
    }],
  };
}

test("MicroCompactionEngine rewrites older compactable tool_results, keeps the last one", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 100 });
  const messages: CanonicalMessage[] = [
    assistantToolCall("a", "read_file"),
    toolResult("a", 500),
    assistantToolCall("b", "read_file"),
    toolResult("b", 500),
    assistantToolCall("c", "read_file"),
    toolResult("c", 500),
  ];
  const result = engine.apply({ messages });
  assert.equal(result.appliedTrigger, "time_based");
  assert.equal(result.rewritten, 2);
  assert.deepEqual(result.toolCallIds, ["a", "b"]);
  const last = result.messages[5]!.content[0] as { content: Array<{ text: string }> };
  assert.equal(last.content[0]?.text.length, 500);
});

test("MicroCompactionEngine returns skipped when only keepLatest results exist", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 50 });
  const messages: CanonicalMessage[] = [
    assistantToolCall("a", "read_file"),
    toolResult("a", 200),
  ];
  const result = engine.apply({ messages });
  assert.equal(result.appliedTrigger, "skipped");
  assert.equal(result.rewritten, 0);
});

test("MicroCompactionEngine skips non-compactable tool results", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 100 });
  const messages: CanonicalMessage[] = [
    assistantToolCall("a", "ask_user_question"),
    toolResult("a", 500),
    assistantToolCall("b", "read_file"),
    toolResult("b", 500),
  ];
  const result = engine.apply({ messages });
  assert.equal(result.appliedTrigger, "skipped");
  assert.equal(result.rewritten, 0);
  // "a" is non-compactable, "b" is the only compactable (within keepLatest)
});

test("MicroCompactionEngine clears multimodal content using actual data length", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 100 });
  const messages: CanonicalMessage[] = [
    assistantToolCall("a", "read_file"),
    toolResultWithImage("a", 50000),
    assistantToolCall("b", "read_file"),
    toolResult("b", 500),
  ];
  const result = engine.apply({ messages });
  assert.equal(result.appliedTrigger, "time_based");
  assert.equal(result.rewritten, 1);
  assert.deepEqual(result.toolCallIds, ["a"]);
  const cleared = result.messages[1]!.content[0] as { content: Array<{ text: string }> };
  assert.equal(cleared.content[0]?.text, MICROCOMPACT_CLEARED);
});

test("MicroCompactionEngine clears standalone multimedia blocks in older user messages", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 100 });
  const messages: CanonicalMessage[] = [
    assistantToolCall("a", "read_file"),
    toolResult("a", 500),
    // supplemental message with PDF data (from data separation)
    { role: "user", content: [{ type: "pdf", source: "base64", data: "x".repeat(10000), mimeType: "application/pdf", bytes: 7500 }] },
    assistantToolCall("b", "read_file"),
    toolResult("b", 500),
  ];
  const result = engine.apply({ messages });
  assert.equal(result.appliedTrigger, "time_based");
  // The supplemental PDF message should be cleared
  const pdfMsg = result.messages[2]!;
  const pdfBlock = pdfMsg.content[0] as { type: string; text?: string };
  assert.equal(pdfBlock.type, "text");
  assert.equal(pdfBlock.text, "[document cleared]");
});

test("MicroCompactionEngine uses MICROCOMPACT_CLEARED marker when clearing", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 100 });
  const messages: CanonicalMessage[] = [
    assistantToolCall("a", "Grep"),
    toolResult("a", 5000),
    assistantToolCall("b", "Glob"),
    toolResult("b", 300),
  ];
  const result = engine.apply({ messages });
  assert.equal(result.rewritten, 1);
  const cleared = result.messages[1]!.content[0] as { content: Array<{ type: string; text: string }> };
  assert.equal(cleared.content[0]?.text, MICROCOMPACT_CLEARED);
});
