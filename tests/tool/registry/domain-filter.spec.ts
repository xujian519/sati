import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import type { SatiToolDefinition, ToolDomain } from "../../../src/tool/protocol/types.js";

function makeTool(name: string, domain?: ToolDomain): SatiToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    kind: "custom",
    ...(domain ? { domain } : {}),
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

test("builtin registry annotates every tool with a domain", () => {
  const registry = createBuiltinRegistry();
  const tools = registry.list();
  assert.ok(tools.length >= 23, "默认注册工具数量应 >= 23");
  for (const tool of tools) {
    assert.ok(tool.domain !== undefined, `tool ${tool.name} 应标注 domain`);
  }
});

test("builtin registry domain mapping is sane", () => {
  const registry = createBuiltinRegistry();
  assert.equal(registry.get("read_file")?.domain, "filesystem");
  assert.equal(registry.get("bash")?.domain, "shell");
  assert.equal(registry.get("web_search")?.domain, "search");
  assert.equal(registry.get("web_fetch")?.domain, "network");
  assert.equal(registry.get("agent")?.domain, "agent");
  assert.equal(registry.get("patent_eval")?.domain, "patent");
  assert.equal(registry.get("rule_check")?.domain, "quality");
  assert.equal(registry.get("todo_write")?.domain, "session");
});

test("listByDomains filters by visible domains", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("read_file", "filesystem"));
  registry.register(makeTool("bash", "shell"));
  registry.register(makeTool("web_search", "search"));
  registry.register(makeTool("unclassified")); // 无 domain

  const visible = new Set(["filesystem", "search"]);
  const filtered = registry.listByDomains({ visible });
  const names = filtered.map(t => t.name).sort();
  assert.deepEqual(names, ["read_file", "unclassified", "web_search"]);
});

test("listByDomains excludes hidden domains (hidden wins over visible)", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("read_file", "filesystem"));
  registry.register(makeTool("bash", "shell"));
  registry.register(makeTool("web_search", "search"));
  registry.register(makeTool("unclassified"));

  const hidden = new Set(["shell"]);
  const filtered = registry.listByDomains({ hidden });
  const names = filtered.map(t => t.name).sort();
  assert.deepEqual(names, ["read_file", "unclassified", "web_search"]);
});

test("listByDomains keeps unclassified tools always visible", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("a", "filesystem"));
  registry.register(makeTool("b", "shell"));
  registry.register(makeTool("c"));
  const filtered = registry.listByDomains({ visible: new Set(["filesystem"]) });
  const names = filtered.map(t => t.name).sort();
  assert.deepEqual(names, ["a", "c"]);
});

test("listByDomains with empty visible keeps everything (hidden only)", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("a", "filesystem"));
  registry.register(makeTool("b", "shell"));
  const filtered = registry.listByDomains({ visible: new Set() });
  assert.equal(filtered.length, 2);
});

test("toCanonicalSchemas applies domain filtering to model schemas", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("read_file", "filesystem"));
  registry.register(makeTool("bash", "shell"));
  registry.register(makeTool("unclassified"));
  const schemas = registry.toCanonicalSchemas({ visible: new Set(["filesystem"]) });
  const names = schemas.map(s => s.name).sort();
  assert.deepEqual(names, ["read_file", "unclassified"]);
});

test("toCanonicalSchemas without options keeps all tools", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("a", "filesystem"));
  registry.register(makeTool("b", "shell"));
  const schemas = registry.toCanonicalSchemas();
  assert.equal(schemas.length, 2);
});
