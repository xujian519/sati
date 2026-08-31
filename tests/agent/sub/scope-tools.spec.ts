import assert from "node:assert/strict";
import test from "node:test";
import { scopeToolsForDefinition } from "../../../src/agent/sub/scopeTools.js";
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

const TOOLS = [
  makeTool("read_file", "filesystem"),
  makeTool("write_file", "filesystem"),
  makeTool("bash", "shell"),
  makeTool("web_search", "search"),
  makeTool("agent", "agent"),
  makeTool("enter_plan_mode", "session"),
  makeTool("always_on_report", "session"),
  makeTool("ask_user_question", "session"),
  makeTool("unclassified"),
];

test("scopeToolsForDefinition honors allowedTools whitelist", () => {
  const result = scopeToolsForDefinition(TOOLS, { allowedTools: ["read_file", "bash"] });
  const names = result.map(t => t.name).sort();
  assert.deepEqual(names, ["bash", "read_file"]);
});

test("scopeToolsForDefinition wildcard keeps everything except hard-blocked", () => {
  const result = scopeToolsForDefinition(TOOLS, { allowedTools: ["*"] });
  const names = result.map(t => t.name);
  // agent / plan mode / always_on / ask_user_question 硬性剔除
  assert.ok(!names.includes("agent"));
  assert.ok(!names.includes("enter_plan_mode"));
  assert.ok(!names.includes("always_on_report"));
  assert.ok(!names.includes("ask_user_question"));
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("unclassified"));
});

test("scopeToolsForDefinition filters by visibleDomains", () => {
  const result = scopeToolsForDefinition(TOOLS, {
    allowedTools: ["*"],
    visibleDomains: ["filesystem", "shell"],
  });
  const names = result.map(t => t.name).sort();
  // filesystem×2 + shell×1 + 无 domain 工具始终可见
  assert.deepEqual(names, ["bash", "read_file", "unclassified", "write_file"]);
});

test("scopeToolsForDefinition excludes hiddenDomains", () => {
  const result = scopeToolsForDefinition(TOOLS, {
    allowedTools: ["*"],
    hiddenDomains: ["shell", "search"],
  });
  const names = result.map(t => t.name);
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("web_search"));
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("unclassified"));
});

test("scopeToolsForDefinition hidden wins over visible", () => {
  const result = scopeToolsForDefinition(TOOLS, {
    allowedTools: ["*"],
    visibleDomains: ["filesystem", "shell"],
    hiddenDomains: ["filesystem"],
  });
  const names = result.map(t => t.name).sort();
  assert.deepEqual(names, ["bash", "unclassified"]);
});

test("scopeToolsForDefinition omitTools excludes by name even for unclassified tools", () => {
  const result = scopeToolsForDefinition(TOOLS, {
    allowedTools: ["*"],
    visibleDomains: ["filesystem", "session", "shell"],
    omitTools: ["unclassified", "write_file"],
  });
  const names = result.map(t => t.name).sort();
  // bash/read_file 命中可见域保留；unclassified 本应因"无 domain 始终可见"保留，
  // omitTools 按其名剔除；write_file 同时命中 domain 白名单，双因子剔除取并集。
  assert.deepEqual(names, ["bash", "read_file"]);
});

test("scopeToolsForDefinition absent domain options behave like legacy whitelist", () => {
  const result = scopeToolsForDefinition(TOOLS, { allowedTools: ["read_file", "agent", "bash"] });
  const names = result.map(t => t.name).sort();
  assert.deepEqual(names, ["bash", "read_file"]);
});

test("builtin registry scoped by domains drops patent tools outside visible set", () => {
  const registry = createBuiltinRegistry();
  const scoped = scopeToolsForDefinition(registry.list(), {
    allowedTools: ["*"],
    visibleDomains: ["filesystem"],
  });
  const names = scoped.map(t => t.name);
  assert.ok(names.includes("read_file"));
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("patent_eval"));
  assert.ok(!names.includes("rule_check"));
});

test("role-style scoping: drafting role sees drafting/quality/patent but not shell", () => {
  const registry = createBuiltinRegistry();
  const scoped = scopeToolsForDefinition(registry.list(), {
    allowedTools: ["*"],
    visibleDomains: ["drafting", "quality", "patent", "filesystem", "session"],
  });
  const names = scoped.map(t => t.name);
  assert.ok(names.includes("draft_claims"));
  assert.ok(names.includes("rule_check"));
  assert.ok(names.includes("read_file"));
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("web_search"));
});
