import test from "node:test";
import assert from "node:assert/strict";
import { PermissionRuntime } from "../../../src/permission/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { SatiToolDefinition } from "../../../src/tool/protocol/types.js";

function bigOutputTool(): SatiToolDefinition<{ n: number }, { content: Array<{ type: "text"; text: string }> }> {
  return {
    name: "big_output",
    description: "emits a large text result for size-limit tests",
    kind: "custom",
    inputSchema: {
      type: "object",
      properties: { n: { type: "number" } },
      additionalProperties: false,
    },
    maxResultBytes: 1024,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => ({
      content: [{ type: "text", text: `head\n${"y".repeat(input.n ?? 10_000)}\ntail` }],
    }),
  };
}

function smallTool(): SatiToolDefinition<{ n: number }, { content: Array<{ type: "text"; text: string }> }> {
  return {
    name: "small_output",
    description: "emits a small text result",
    kind: "custom",
    inputSchema: {
      type: "object",
      properties: { n: { type: "number" } },
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => ({
      content: [{ type: "text", text: `head\n${"y".repeat(input.n ?? 5)}\ntail` }],
    }),
  };
}

function context(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function runtime(): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(bigOutputTool());
  return new ToolRuntime(registry, new PermissionRuntime());
}

test("direct path without spill layer truncates oversized results and records metadata", async () => {
  const result = await runtime().execute({ id: "call-1", name: "big_output", input: { n: 10_000 } }, context());
  assert.equal(result.type, "success");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  // 截断生效：保留头尾 + 截断标记，且远小于原文 10KB。
  assert.match(text, /^head/);
  assert.match(text, /tail/);
  assert.match(text, /Tool output truncated/);
  assert.ok(Buffer.byteLength(text, "utf8") <= 1024 + 200, "truncated text must respect maxResultBytes");
  const limit = (result.metadata?.previewLimit ?? {}) as { truncated?: boolean; originalBytes?: number };
  assert.equal(limit.truncated, true);
  assert.ok((limit.originalBytes ?? 0) > 10_000);
});

test("spill-active path keeps the full original content untruncated", async () => {
  const result = await runtime().execute(
    { id: "call-2", name: "big_output", input: { n: 10_000 } },
    context({ spillLayerActive: true }),
  );
  assert.equal(result.type, "success");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  // ToolResultBudget 会负责替换，ToolRuntime 必须保留完整原文供落盘。
  assert.equal(text.length, 10_000 + "head\n".length + "\ntail".length);
  assert.doesNotMatch(text, /Tool output truncated/);
});

test("no maxResultBytes configured means no truncation", async () => {
  const registry = new ToolRegistry();
  registry.register(smallTool());
  const rt = new ToolRuntime(registry, new PermissionRuntime());
  const result = await rt.execute({ id: "call-3", name: "small_output", input: { n: 5 } }, context());
  assert.equal(result.type, "success");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.equal(text, "head\n" + "y".repeat(5) + "\ntail");
});
