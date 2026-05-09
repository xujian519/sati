import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MCP_TOOL_DESCRIPTION_LENGTH,
  truncateMcpToolDescription,
} from "../../src/mcp/index.js";

test("C1.M11 truncateMcpToolDescription preserves short input", () => {
  assert.equal(truncateMcpToolDescription("hello"), "hello");
});

test("C1.M11 truncateMcpToolDescription caps body and appends marker", () => {
  const big = "a".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH * 4);
  const out = truncateMcpToolDescription(big);
  assert.ok(out.startsWith("a".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH)));
  assert.ok(out.includes("[truncated]"));
});

test("C1.M11 boundary length is preserved as-is", () => {
  const exact = "x".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH);
  assert.equal(truncateMcpToolDescription(exact), exact);
});

test("C1.M11 returns empty string for empty input", () => {
  assert.equal(truncateMcpToolDescription(""), "");
});
