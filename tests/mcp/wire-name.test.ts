import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMcpToolWireName,
  parseMcpToolWireName,
} from "../../src/mcp/index.js";

test("C1.M10 buildMcpToolWireName uses mcp__server__tool format", () => {
  assert.equal(buildMcpToolWireName("figma", "search"), "mcp__figma__search");
});

test("C1.M10 normalizes non-safe characters to underscore", () => {
  assert.equal(
    buildMcpToolWireName("plugin-figma.figma", "Get-Design Context"),
    "mcp__plugin-figma_figma__Get-Design_Context",
  );
});

test("C1.M10 parseMcpToolWireName round-trips for safe segments", () => {
  const wire = buildMcpToolWireName("figma", "search");
  const parsed = parseMcpToolWireName(wire);
  assert.deepEqual(parsed, { serverId: "figma", toolName: "search" });
});

test("C1.M10 parseMcpToolWireName returns null for non-mcp__ prefix", () => {
  assert.equal(parseMcpToolWireName("foo__bar__baz"), null);
});

test("C1.M10 parseMcpToolWireName returns null when missing a segment", () => {
  assert.equal(parseMcpToolWireName("mcp__only"), null);
});
