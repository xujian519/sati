import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpToolWireName, parseMcpToolWireName } from "../../../src/mcp/protocol/wireName.js";

test("buildMcpToolWireName produces mcp__<server>__<tool>", () => {
  assert.equal(buildMcpToolWireName("filesystem", "read_file"), "mcp__filesystem__read_file");
});

test("buildMcpToolWireName keeps ASCII alphanumerics, underscores and dashes", () => {
  assert.equal(buildMcpToolWireName("browser-use", "take-screenshot"), "mcp__browser-use__take-screenshot");
  assert.equal(buildMcpToolWireName("my_server", "my_tool"), "mcp__my_server__my_tool");
});

test("buildMcpToolWireName replaces unsafe characters with underscores", () => {
  assert.equal(buildMcpToolWireName("my server", "my tool"), "mcp__my_server__my_tool");
  assert.equal(buildMcpToolWireName("a.b/c", "d(e)"), "mcp__a_b_c__d_e_");
});

test("parseMcpToolWireName round-trips build output", () => {
  for (const [serverId, toolName] of [
    ["filesystem", "read_file"],
    ["browser-use", "take-screenshot"],
    ["a", "b"],
  ]) {
    const wireName = buildMcpToolWireName(serverId, toolName);
    assert.deepEqual(parseMcpToolWireName(wireName), { serverId, toolName });
  }
});

test("parseMcpToolWireName rejects non-mcp wire names", () => {
  assert.equal(parseMcpToolWireName("read_file"), null);
  assert.equal(parseMcpToolWireName("mcp_filesystem_read_file"), null);
  assert.equal(parseMcpToolWireName(""), null);
});

test("parseMcpToolWireName rejects empty segments", () => {
  assert.equal(parseMcpToolWireName("mcp__"), null);
  assert.equal(parseMcpToolWireName("mcp__server"), null);
  assert.equal(parseMcpToolWireName("mcp____tool"), null); // empty serverId
  assert.equal(parseMcpToolWireName("mcp__server__"), null); // empty toolName
});

test("parseMcpToolWireName handles tool names containing double underscores", () => {
  // The separator is the FIRST "__" after the "mcp__" prefix.
  const wireName = buildMcpToolWireName("server", "a__b");
  assert.equal(wireName, "mcp__server__a__b");
  assert.deepEqual(parseMcpToolWireName(wireName), { serverId: "server", toolName: "a__b" });
});

test("parseMcpToolWireName normalizes serverId and toolName the same way as build", () => {
  // build() sanitizes both segments; parse() must recover the sanitized forms.
  const wireName = buildMcpToolWireName("my server", "my tool");
  assert.deepEqual(parseMcpToolWireName(wireName), { serverId: "my_server", toolName: "my_tool" });
});
