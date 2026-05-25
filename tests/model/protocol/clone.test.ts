import test from "node:test";
import assert from "node:assert/strict";
import type {
  CanonicalMessage,
  CanonicalToolResultBlock,
  CanonicalToolCallBlock,
} from "../../../src/model/index.js";
import { cloneContentBlock, cloneMessage, cloneMessages } from "../../../src/model/index.js";

function toolResultMessage(): CanonicalMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "tc_1",
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: "base64", data: "abc", mimeType: "image/png" },
        ],
      } satisfies CanonicalToolResultBlock,
    ],
  };
}

function toolCallMessage(): CanonicalMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id: "tc_1",
        name: "read_file",
        input: { path: "/tmp/foo", nested: { a: 1 } },
      } satisfies CanonicalToolCallBlock,
    ],
  };
}

test("cloneContentBlock: tool_result content array is a different reference", () => {
  const original: CanonicalToolResultBlock = {
    type: "tool_result",
    toolCallId: "tc_1",
    content: [{ type: "text", text: "hello" }],
  };
  const cloned = cloneContentBlock(original) as CanonicalToolResultBlock;

  assert.deepStrictEqual(cloned, original);
  assert.notStrictEqual(cloned.content, original.content);
  assert.notStrictEqual(cloned.content[0], original.content[0]);
});

test("cloneContentBlock: tool_call input is a different reference", () => {
  const original: CanonicalToolCallBlock = {
    type: "tool_call",
    id: "tc_1",
    name: "read_file",
    input: { path: "/tmp/foo" },
  };
  const cloned = cloneContentBlock(original) as CanonicalToolCallBlock;

  assert.deepStrictEqual(cloned, original);
  assert.notStrictEqual(cloned.input, original.input);
});

test("cloneContentBlock: text block is a different reference", () => {
  const original = { type: "text" as const, text: "hello" };
  const cloned = cloneContentBlock(original);

  assert.deepStrictEqual(cloned, original);
  assert.notStrictEqual(cloned, original);
});

test("cloneMessage: produces deep-equal but reference-isolated message", () => {
  const original = toolResultMessage();
  const cloned = cloneMessage(original);

  assert.deepStrictEqual(cloned, original);
  assert.notStrictEqual(cloned, original);
  assert.notStrictEqual(cloned.content, original.content);

  const origBlock = original.content[0] as CanonicalToolResultBlock;
  const clonedBlock = cloned.content[0] as CanonicalToolResultBlock;
  assert.notStrictEqual(clonedBlock, origBlock);
  assert.notStrictEqual(clonedBlock.content, origBlock.content);
});

test("cloneMessages: mutation on cloned tool_result.content does not affect original", () => {
  const originals = [toolResultMessage()];
  const cloned = cloneMessages(originals);

  const clonedBlock = cloned[0].content[0] as CanonicalToolResultBlock;
  clonedBlock.content.push({ type: "text", text: "injected" });

  const origBlock = originals[0].content[0] as CanonicalToolResultBlock;
  assert.strictEqual(origBlock.content.length, 2);
  assert.strictEqual(clonedBlock.content.length, 3);
});

test("cloneMessages: mutation on cloned tool_call.input does not affect original", () => {
  const originals = [toolCallMessage()];
  const cloned = cloneMessages(originals);

  const clonedBlock = cloned[0].content[0] as CanonicalToolCallBlock;
  (clonedBlock.input as Record<string, unknown>).injected = true;

  const origBlock = originals[0].content[0] as CanonicalToolCallBlock;
  assert.strictEqual((origBlock.input as Record<string, unknown>).injected, undefined);
});

test("cloneMessages: mixed message array preserves all block types", () => {
  const messages: CanonicalMessage[] = [
    toolCallMessage(),
    toolResultMessage(),
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const cloned = cloneMessages(messages);

  assert.deepStrictEqual(cloned, messages);
  assert.strictEqual(cloned.length, 3);
  for (let i = 0; i < messages.length; i++) {
    assert.notStrictEqual(cloned[i], messages[i]);
    assert.notStrictEqual(cloned[i].content, messages[i].content);
  }
});
