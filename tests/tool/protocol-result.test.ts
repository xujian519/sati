import test from "node:test";
import assert from "node:assert/strict";
import { toCanonicalToolResultBlock, type PilotDeckToolResult } from "../../src/tool/index.js";

test("maps success and error results to canonical tool_result blocks", () => {
  const success: PilotDeckToolResult = {
    type: "success",
    toolCallId: "call-1",
    toolName: "read_file",
    content: [{ type: "text", text: "hello" }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
  const error: PilotDeckToolResult = {
    type: "error",
    toolCallId: "call-2",
    toolName: "write_file",
    error: { code: "permission_denied", message: "Denied." },
    content: [{ type: "text", text: "Denied." }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(toCanonicalToolResultBlock(success).isError, undefined);
  assert.equal(toCanonicalToolResultBlock(error).isError, true);
});

test("injects stable text for empty content", () => {
  const result: PilotDeckToolResult = {
    type: "success",
    toolCallId: "call-1",
    toolName: "empty",
    content: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };

  const block = toCanonicalToolResultBlock(result).content[0];
  assert.equal(block?.type, "text");
  assert.equal(block?.text, "Tool completed with no output.");
});

test("preserves image and pdf blocks in canonical tool results", () => {
  const result: PilotDeckToolResult = {
    type: "success",
    toolCallId: "call-1",
    toolName: "read_file",
    content: [
      { type: "text", text: "Requested PDF pages: 1-2." },
      { type: "image", mimeType: "image/png", data: "abc", bytes: 3 },
      { type: "pdf", mimeType: "application/pdf", data: "def", bytes: 3, pages: 2 },
    ],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };

  const block = toCanonicalToolResultBlock(result);
  assert.equal(block.content[0]?.type, "text");
  assert.equal(block.content[1]?.type, "image");
  assert.equal(block.content[2]?.type, "pdf");
});
