import test from "node:test";
import assert from "node:assert/strict";
import { toCanonicalToolResultBlock, type PolitDeckToolResult } from "../../src/tool/index.js";

test("maps success and error results to canonical tool_result blocks", () => {
  const success: PolitDeckToolResult = {
    type: "success",
    toolCallId: "call-1",
    toolName: "read_file",
    content: [{ type: "text", text: "hello" }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
  const error: PolitDeckToolResult = {
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
  const result: PolitDeckToolResult = {
    type: "success",
    toolCallId: "call-1",
    toolName: "empty",
    content: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(toCanonicalToolResultBlock(result).content[0]?.text, "Tool completed with no output.");
});
