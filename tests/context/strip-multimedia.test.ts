import test from "node:test";
import assert from "node:assert/strict";
import { stripMultimediaFromMessages } from "../../src/context/compaction/stripMultimedia.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("stripMultimediaFromMessages replaces top-level image blocks with [image]", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "image", source: "base64", data: "x".repeat(1000), mimeType: "image/jpeg" }] },
  ];
  const result = stripMultimediaFromMessages(messages);
  assert.equal(result[0]!.content[0]!.type, "text");
  assert.equal((result[0]!.content[0] as { text: string }).text, "[image]");
});

test("stripMultimediaFromMessages replaces top-level pdf blocks with [document]", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "pdf", source: "base64", data: "x".repeat(5000), mimeType: "application/pdf", bytes: 3750 }] },
  ];
  const result = stripMultimediaFromMessages(messages);
  assert.equal(result[0]!.content[0]!.type, "text");
  assert.equal((result[0]!.content[0] as { text: string }).text, "[document]");
});

test("stripMultimediaFromMessages replaces image/pdf inside tool_result", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "some text" },
          { type: "image", source: "base64", data: "imgdata", mimeType: "image/png" },
        ],
      }],
    },
  ];
  const result = stripMultimediaFromMessages(messages);
  const toolResult = result[0]!.content[0] as { content: Array<{ type: string; text?: string }> };
  assert.equal(toolResult.content[0]!.type, "text");
  assert.equal(toolResult.content[0]!.text, "some text");
  assert.equal(toolResult.content[1]!.type, "text");
  assert.equal(toolResult.content[1]!.text, "[image]");
});

test("stripMultimediaFromMessages does not modify assistant messages", () => {
  const messages: CanonicalMessage[] = [
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  const result = stripMultimediaFromMessages(messages);
  assert.strictEqual(result[0], messages[0]);
});

test("stripMultimediaFromMessages preserves text-only user messages by reference", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "just text" }] },
  ];
  const result = stripMultimediaFromMessages(messages);
  assert.strictEqual(result[0], messages[0]);
});
