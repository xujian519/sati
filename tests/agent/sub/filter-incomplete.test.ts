import test from "node:test";
import assert from "node:assert/strict";
import { filterIncompleteToolCalls } from "../../../src/agent/sub/index.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

test("C2.S4 drops tool_call without matching tool_result", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "complete", name: "x", input: {} },
        { type: "tool_call", id: "orphan", name: "y", input: {} },
        { type: "text", text: "narration" },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "complete",
          content: [{ type: "text", text: "ok" }],
        },
      ],
    },
  ];
  const out = filterIncompleteToolCalls(messages);
  assert.equal(out.length, 2);
  const assistant = out[0];
  const ids = assistant.content
    .filter((b) => b.type === "tool_call")
    .map((b) => (b.type === "tool_call" ? b.id : ""));
  assert.deepEqual(ids, ["complete"]);
});

test("C2.S4 removes assistant message that becomes empty after filtering", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "orphan", name: "y", input: {} }],
    },
  ];
  const out = filterIncompleteToolCalls(messages);
  assert.equal(out.length, 0);
});

test("C2.S4 leaves user messages untouched", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  const out = filterIncompleteToolCalls(messages);
  assert.deepEqual(out, messages);
});

test("C2.S4 idempotent on already-clean messages", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "a", name: "x", input: {} },
        { type: "text", text: "narration" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "a", content: [{ type: "text", text: "ok" }] },
      ],
    },
  ];
  const first = filterIncompleteToolCalls(messages);
  const second = filterIncompleteToolCalls(first);
  assert.deepEqual(second, first);
});
