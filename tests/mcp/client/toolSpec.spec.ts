import assert from "node:assert/strict";
import test from "node:test";
import { toToolSpec } from "../../../src/mcp/client/toolSpec.js";

test("toToolSpec: 分配 wireName mcp__<serverId>__<name> 并透传字段", () => {
  const spec = toToolSpec({ name: "add", description: "加法", inputSchema: { type: "object" } }, "calc-server");
  assert.equal(spec.serverId, "calc-server");
  assert.equal(spec.toolName, "add");
  assert.equal(spec.wireName, "mcp__calc-server__add");
  assert.equal(spec.description, "加法");
  assert.deepEqual(spec.inputSchema, { type: "object" });
});

test("toToolSpec: 无 inputSchema 时回退空 object schema", () => {
  const spec = toToolSpec({ name: "ping" }, "s1");
  assert.deepEqual(spec.inputSchema, { type: "object", properties: {} });
  assert.equal(spec.meta, undefined);
});

test("toToolSpec: 超长描述被截断（truncateMcpToolDescription ≤ 2048 + 后缀）", () => {
  const spec = toToolSpec({ name: "big", description: "x".repeat(5_000) }, "s1");
  assert.ok(spec.description.length <= 2_048 + "… [truncated]".length, `描述应截断，实际 ${spec.description.length}`);
  assert.match(spec.description, /\[truncated\]$/, "截断描述应带标记后缀");
});
