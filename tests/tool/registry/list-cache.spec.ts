import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { SatiToolDefinition } from "../../../src/tool/protocol/types.js";

function makeTool(name: string): SatiToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

test("list() 返回排序结果且连续调用共享缓存（同一引用）", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("z_tool"));
  registry.register(makeTool("a_tool"));
  registry.register(makeTool("m_tool"));

  const first = registry.list();
  assert.deepEqual(
    first.map(t => t.name),
    ["a_tool", "m_tool", "z_tool"],
    "list() 应按名称升序排序",
  );
  assert.equal(registry.list(), first, "注册表未变更时 list() 应返回缓存数组（避免每轮重新排序）");
});

test("register 后缓存失效，list() 反映新工具", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("b_tool"));
  const before = registry.list();
  registry.register(makeTool("a_tool"));
  const after = registry.list();
  assert.notEqual(after, before, "注册新工具后应返回新数组");
  assert.deepEqual(
    after.map(t => t.name),
    ["a_tool", "b_tool"],
    "新工具应出现在排序后的列表",
  );
});

test("unregister 后缓存失效", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("a_tool"));
  registry.register(makeTool("b_tool"));
  assert.equal(registry.unregister("a_tool"), true);
  assert.deepEqual(
    registry.list().map(t => t.name),
    ["b_tool"],
  );
});

test("replace 后缓存失效且保持排序", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("a_tool"));
  const replacement = makeTool("a_tool");
  replacement.description = "replaced";
  registry.replace(replacement);
  const tools = registry.list();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.description, "replaced");
  assert.deepEqual(
    tools.map(t => t.name),
    ["a_tool"],
  );
});

test("list() 返回值按只读约定使用：调用方修改元素不得污染缓存排序", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("b_tool"));
  registry.register(makeTool("a_tool"));
  registry.list(); // 预热缓存
  // 调用方不应修改数组；即便误改，下一次注册仍会重建干净的缓存
  registry.register(makeTool("c_tool"));
  const refreshed = registry.list();
  assert.deepEqual(
    refreshed.map(t => t.name),
    ["a_tool", "b_tool", "c_tool"],
  );
});
