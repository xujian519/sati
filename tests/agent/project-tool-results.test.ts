import test from "node:test";
import assert from "node:assert/strict";
import { projectToolResults } from "../../src/agent/loop/projectToolResults.js";
import type { PilotDeckToolSuccessResult, PilotDeckToolResult } from "../../src/tool/index.js";

function makeResult(overrides: Partial<PilotDeckToolSuccessResult> & { toolCallId: string; toolName: string }): PilotDeckToolSuccessResult {
  return {
    type: "success",
    content: [{ type: "text", text: "done" }],
    startedAt: "2025-01-01T00:00:00Z",
    completedAt: "2025-01-01T00:00:01Z",
    ...overrides,
  };
}

test("projectToolResults returns array with single tool_result message for text-only results", () => {
  const results: PilotDeckToolResult[] = [
    makeResult({ toolCallId: "tc1", toolName: "read_file" }),
  ];
  const messages = projectToolResults(results);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, "user");
  assert.equal(messages[0]!.content[0]!.type, "tool_result");
});

test("projectToolResults does NOT duplicate image blocks as sibling content", () => {
  const results: PilotDeckToolResult[] = [
    makeResult({
      toolCallId: "tc1",
      toolName: "read_file",
      content: [{ type: "image", mimeType: "image/jpeg", data: "base64data", bytes: 100 }],
    }),
  ];
  const messages = projectToolResults(results);
  assert.equal(messages.length, 1);
  // Only the tool_result block; no duplicate top-level image block
  assert.equal(messages[0]!.content.length, 1);
  assert.equal(messages[0]!.content[0]!.type, "tool_result");
});

test("projectToolResults appends supplementalMessages as separate user messages", () => {
  const results: PilotDeckToolResult[] = [
    makeResult({
      toolCallId: "tc1",
      toolName: "read_file",
      content: [{ type: "text", text: "PDF file read: test.pdf (1234 bytes)" }],
      supplementalMessages: [{
        role: "user",
        content: [{ type: "pdf", mimeType: "application/pdf", data: "JVBERi0x...", bytes: 1234, pages: 3 }],
        isMeta: true,
      }],
    }),
  ];
  const messages = projectToolResults(results);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "user");
  assert.equal(messages[0]!.content[0]!.type, "tool_result");
  assert.equal(messages[1]!.role, "user");
  assert.equal(messages[1]!.content[0]!.type, "pdf");
});

test("projectToolResults handles multiple results with mixed supplementalMessages", () => {
  const results: PilotDeckToolResult[] = [
    makeResult({
      toolCallId: "tc1",
      toolName: "read_file",
      content: [{ type: "text", text: "PDF file read: a.pdf" }],
      supplementalMessages: [{
        role: "user",
        content: [{ type: "pdf", mimeType: "application/pdf", data: "pdf1", bytes: 100 }],
        isMeta: true,
      }],
    }),
    makeResult({
      toolCallId: "tc2",
      toolName: "grep",
      content: [{ type: "text", text: "grep results" }],
    }),
  ];
  const messages = projectToolResults(results);
  // First message: both tool_results
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.content.length, 2); // two tool_result blocks
  // Second message: supplemental from tc1
  assert.equal(messages[1]!.content[0]!.type, "pdf");
});
