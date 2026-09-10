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

test("buildMcpToolWireName collapses underscore runs in the server segment", () => {
  // parse() splits at the FIRST "__" after the prefix, so a server segment
  // containing "__" would make the separator ambiguous and parse to a
  // different server/tool pair.
  const wireName = buildMcpToolWireName("0__A", "a");
  assert.equal(wireName, "mcp__0_A__a");
  assert.deepEqual(parseMcpToolWireName(wireName), { serverId: "0_A", toolName: "a" });
});

test("buildMcpToolWireName trims edge underscores off the server segment", () => {
  // A trailing "_" would fuse with the "__" separator into "___".
  assert.equal(buildMcpToolWireName("srv_", "tool"), "mcp__srv__tool");
  assert.equal(buildMcpToolWireName("_srv", "tool"), "mcp__srv__tool");
  assert.deepEqual(parseMcpToolWireName(buildMcpToolWireName("srv_", "tool")), {
    serverId: "srv",
    toolName: "tool",
  });
});

test("buildMcpToolWireName collapses runs created by unsafe characters", () => {
  assert.equal(buildMcpToolWireName("a..b", "tool"), "mcp__a_b__tool");
  // Single underscores inside the server ID carry meaning and must survive.
  assert.equal(buildMcpToolWireName("my_server", "tool"), "mcp__my_server__tool");
});

test("buildMcpToolWireName leaves the tool segment free to contain double underscores", () => {
  assert.equal(buildMcpToolWireName("server", "a__b"), "mcp__server__a__b");
});
