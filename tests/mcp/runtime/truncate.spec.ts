import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MCP_TOOL_DESCRIPTION_LENGTH, truncateMcpToolDescription } from "../../../src/mcp/runtime/truncate.js";

test("truncateMcpToolDescription keeps short descriptions as-is", () => {
  assert.equal(truncateMcpToolDescription("short description"), "short description");
  assert.equal(truncateMcpToolDescription(""), "");
});

test("truncateMcpToolDescription keeps descriptions exactly at the limit", () => {
  const value = "x".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH);
  assert.equal(truncateMcpToolDescription(value), value);
});

test("truncateMcpToolDescription clamps long descriptions and marks them truncated", () => {
  const value = "y".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH + 100);
  const result = truncateMcpToolDescription(value);
  assert.equal(result.length, MAX_MCP_TOOL_DESCRIPTION_LENGTH + "… [truncated]".length);
  assert.ok(result.endsWith("… [truncated]"));
  assert.ok(result.startsWith("y".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH)));
});
