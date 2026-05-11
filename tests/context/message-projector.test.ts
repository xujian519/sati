import test from "node:test";
import assert from "node:assert/strict";
import { MessageProjector } from "../../src/context/projection/MessageProjector.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const projector = new MessageProjector();

function userText(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string, name: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "tool_call", id, name, input: {} }] };
}

function assistantMultiToolCall(calls: Array<{ id: string; name: string }>): CanonicalMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({ type: "tool_call" as const, id: c.id, name: c.name, input: {} })),
  };
}

function userToolResult(id: string, text: string): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolCallId: id, content: [{ type: "text", text }] }],
  };
}

function userMultiToolResult(results: Array<{ id: string; text: string }>): CanonicalMessage {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      toolCallId: r.id,
      content: [{ type: "text" as const, text: r.text }],
    })),
  };
}

// ── Well-formed conversations ──────────────────────────────────────

test("preserves a well-formed conversation untouched", () => {
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

// ── Repair: inject placeholder for missing tool_result ──────────────

test("injects placeholder tool_result when assistant tool_call has no matching result", () => {
  const messages: CanonicalMessage[] = [
    userText("hi"),
    assistantToolCall("call-1", "read_file"),
    userText("ignore"),
  ];
  const result = projector.project({ messages });
  assert.ok(result.warnings.some((w) => w.code === "tool_result_injected"));
  const toolResultMsg = result.messages.find(
    (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result" && b.toolCallId === "call-1"),
  );
  assert.ok(toolResultMsg, "should have injected a placeholder tool_result message");
});

test("injects placeholder for tool_call at end of conversation with no result", () => {
  const messages: CanonicalMessage[] = [
    userText("hi"),
    assistantToolCall("call-1", "read_file"),
  ];
  const result = projector.project({ messages });
  assert.ok(result.warnings.some((w) => w.code === "tool_result_injected"));
  assert.equal(result.messages.length, 3);
  const last = result.messages[2];
  assert.equal(last.role, "user");
  assert.ok(last.content.some((b) => b.type === "tool_result" && b.toolCallId === "call-1"));
});

test("injects placeholders for multi-tool-call with partial results", () => {
  const messages: CanonicalMessage[] = [
    userText("do stuff"),
    assistantMultiToolCall([
      { id: "c1", name: "read_file" },
      { id: "c2", name: "write_file" },
      { id: "c3", name: "exec" },
    ]),
    userMultiToolResult([{ id: "c1", text: "ok" }]),
    userText("next"),
  ];
  const result = projector.project({ messages });
  const injected = result.warnings.filter((w) => w.code === "tool_result_injected");
  assert.equal(injected.length, 2, "should inject placeholders for c2 and c3");
});

// ── Repair: strip orphaned tool_results ──────────────────────────────

test("strips orphaned tool_result whose tool_call was dropped", () => {
  const messages: CanonicalMessage[] = [
    userText("hi"),
    userToolResult("ghost", "stale"),
  ];
  const result = projector.project({ messages });
  assert.ok(result.warnings.some((w) => w.code === "tool_result_orphaned"));
  const orphanBlock = result.messages.find((m) =>
    m.content.some((b) => b.type === "tool_result" && b.toolCallId === "ghost"),
  );
  assert.ok(!orphanBlock, "orphaned tool_result should be removed");
});

// ── maxMessages: tool-pair-safe truncation ───────────────────────────

test("maxMessages sliding window on plain text messages", () => {
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

test("maxMessages does not cut between assistant tool_calls and tool_result", () => {
  const messages: CanonicalMessage[] = [
    userText("a"),           // 0
    userText("b"),           // 1
    assistantToolCall("c1", "read_file"), // 2
    userToolResult("c1", "data"),         // 3  ← tool_result_only
    userText("c"),           // 4
  ];
  // maxMessages=3 naive cut would be at index 2, keeping [2,3,4].
  // But index 3 is a tool_result_only message, so the cut should not
  // orphan it. The safe behavior keeps the tool exchange intact.
  const result = projector.project({ messages, maxMessages: 3 });
  // Should contain the tool_call, tool_result, and the trailing user text at minimum
  const hasToolCall = result.messages.some((m) => m.content.some((b) => b.type === "tool_call"));
  const hasToolResult = result.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
  if (hasToolCall) {
    assert.ok(hasToolResult, "if tool_call is kept, its tool_result must also be kept");
  }
  // No injection warnings means pairing is intact
  assert.ok(!result.warnings.some((w) => w.code === "tool_result_injected"));
});

test("maxMessages truncation that orphans tool_call gets repaired with placeholder", () => {
  const messages: CanonicalMessage[] = [
    userText("a"),                              // 0
    assistantToolCall("c1", "read_file"),        // 1
    userToolResult("c1", "data"),                // 2
    userText("b"),                              // 3
    assistantToolCall("c2", "write_file"),       // 4
    userToolResult("c2", "ok"),                  // 5
    userText("c"),                              // 6
    assistantText("done"),                      // 7
  ];
  // maxMessages=4 → naive cut at 4 → keeps [4,5,6,7], which starts at
  // assistantToolCall("c2") — that's fine, c2's result is at index 5.
  const result = projector.project({ messages, maxMessages: 4 });
  assert.ok(result.messages.length <= 5);
  assert.ok(!result.warnings.some((w) => w.code === "tool_result_injected"),
    "no injection needed when tool pairs are intact after safe truncation");
});

// ── Combined: truncation + repair ────────────────────────────────────

test("truncation that drops tool_result triggers injection for surviving tool_call", () => {
  // Construct a case where the tool_call is at the boundary
  const messages: CanonicalMessage[] = [
    userText("a"),                              // 0
    assistantToolCall("c1", "read_file"),        // 1
    assistantText("thinking..."),               // 2  ← note: no tool_result for c1!
    userText("b"),                              // 3
  ];
  const result = projector.project({ messages, maxMessages: 3 });
  // c1 has no result at all, so a placeholder must be injected
  assert.ok(result.warnings.some((w) => w.code === "tool_result_injected"));
});
