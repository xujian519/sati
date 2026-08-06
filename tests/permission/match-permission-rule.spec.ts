import assert from "node:assert/strict";
import test from "node:test";
import { matchPermissionRule } from "../../src/permission/policy/matchPermissionRule.js";
import {
  createDefaultPermissionContext,
  type PermissionContext,
  type PermissionRule,
} from "../../src/permission/index.js";

function rule(overrides: Partial<PermissionRule> & { toolName: string }): PermissionRule {
  return { source: "user", behavior: "allow", ...overrides };
}

function ctx(cwd: string = "/home/u/proj", additional?: string[]): PermissionContext {
  return createDefaultPermissionContext({ cwd, additionalWorkingDirectories: additional ?? [] });
}

test("tool name matches exactly", () => {
  assert.equal(matchPermissionRule(rule({ toolName: "read_file" }), "read_file", {}), true);
  assert.equal(matchPermissionRule(rule({ toolName: "read_file" }), "write_file", {}), false);
});

test("tool name wildcard matches any tool", () => {
  const wildcard = rule({ toolName: "*" });
  assert.equal(matchPermissionRule(wildcard, "read_file", {}), true);
  assert.equal(matchPermissionRule(wildcard, "bash", { command: "ls" }), true);
});

test("tool name prefix wildcard matches subset", () => {
  const prefix = rule({ toolName: "web_*" });
  assert.equal(matchPermissionRule(prefix, "web_search", {}), true);
  assert.equal(matchPermissionRule(prefix, "web_fetch", {}), true);
  assert.equal(matchPermissionRule(prefix, "bash", {}), false);
});

test("no pattern on non-file tools matches regardless of input", () => {
  const r = rule({ toolName: "bash" });
  assert.equal(matchPermissionRule(r, "bash", { command: "rm -rf /" }), true);
  assert.equal(matchPermissionRule(r, "bash", undefined), true);
});

test("bash pattern matches command with wildcard", () => {
  const r = rule({ toolName: "bash", pattern: "rm -rf*" });
  assert.equal(matchPermissionRule(r, "bash", { command: "rm -rf /tmp/x" }), true);
  assert.equal(matchPermissionRule(r, "bash", { command: "ls -la" }), false);
});

test("bash pattern with trailing colon-star normalizes to wildcard", () => {
  const r = rule({ toolName: "bash", pattern: "npm run build:*" });
  assert.equal(matchPermissionRule(r, "bash", { command: "npm run build:prod" }), true);
  assert.equal(matchPermissionRule(r, "bash", { command: "npm run dev" }), false);
});

test("bash rule without command input does not match", () => {
  const r = rule({ toolName: "bash", pattern: "rm*" });
  assert.equal(matchPermissionRule(r, "bash", { other: "field" }), false);
  assert.equal(matchPermissionRule(r, "bash", undefined), false);
});

test("file path pattern matches absolute path", () => {
  const r = rule({ toolName: "read_file", pattern: "/home/u/**/notes.md" });
  assert.equal(matchPermissionRule(r, "read_file", { file_path: "/home/u/a/b/notes.md" }, ctx()), true);
  assert.equal(matchPermissionRule(r, "read_file", { file_path: "/home/u/a/b/other.md" }, ctx()), false);
});

test("file path pattern matches absolute pattern against relative input", () => {
  const r = rule({ toolName: "read_file", pattern: "/home/u/proj/src/**" });
  const c = ctx("/home/u/proj");
  assert.equal(matchPermissionRule(r, "read_file", { file_path: "src/tool/x.ts" }, c), true);
  assert.equal(matchPermissionRule(r, "read_file", { file_path: "./src/tool/x.ts" }, c), true);
  assert.equal(matchPermissionRule(r, "read_file", { file_path: "lib/x.ts" }, c), false);
});

test("write tool without pattern requires path inside workspace", () => {
  const r = rule({ toolName: "write_file" });
  const c = ctx("/home/u/proj", ["/mnt/shared"]);
  // cwd 内相对路径
  assert.equal(matchPermissionRule(r, "write_file", { file_path: "a.txt" }, c), true);
  // cwd 内绝对路径
  assert.equal(matchPermissionRule(r, "write_file", { file_path: "/home/u/proj/a.txt" }, c), true);
  // additionalWorkingDirectories
  assert.equal(matchPermissionRule(r, "write_file", { file_path: "/mnt/shared/x.txt" }, c), true);
  // 越界（..）
  assert.equal(matchPermissionRule(r, "write_file", { file_path: "../escape.txt" }, c), false);
  // 越界绝对路径
  assert.equal(matchPermissionRule(r, "write_file", { file_path: "/etc/passwd" }, c), false);
  // 前缀相似但不包含（/home/u/proj2 不是 /home/u/proj 内）
  assert.equal(matchPermissionRule(r, "write_file", { file_path: "/home/u/proj2/a.txt" }, c), false);
});

test("write tool without pattern and without context never matches", () => {
  const r = rule({ toolName: "write_file" });
  assert.equal(matchPermissionRule(r, "write_file", { file_path: "a.txt" }, undefined), false);
});

test("write tool without pattern and without file path does not match", () => {
  const r = rule({ toolName: "write_file" });
  assert.equal(matchPermissionRule(r, "write_file", { content: "no path" }, ctx()), false);
});

test("edit_file uses filePath or file_path field", () => {
  const r = rule({ toolName: "edit_file" });
  const c = ctx("/home/u/proj");
  assert.equal(matchPermissionRule(r, "edit_file", { filePath: "a.txt" }, c), true);
  assert.equal(matchPermissionRule(r, "edit_file", { file_path: "b.txt" }, c), true);
});

test("text: pattern matches any string value case-insensitively", () => {
  const r = rule({ toolName: "*", pattern: "text:赌博|Betting" });
  const c = ctx();
  assert.equal(matchPermissionRule(r, "write_file", { content: "包含赌博内容" }, c), true);
  assert.equal(matchPermissionRule(r, "web_search", { query: "betting sites" }, c), true);
  assert.equal(matchPermissionRule(r, "web_search", { query: "安全内容" }, c), false);
});

test("text: pattern ignores JSON keys and empty inputs", () => {
  const r = rule({ toolName: "*", pattern: "text:赌博" });
  assert.equal(matchPermissionRule(r, "web_search", { gambling: "safe query" }, ctx()), false);
  assert.equal(matchPermissionRule(r, "bash", undefined, ctx()), false);
  assert.equal(matchPermissionRule(r, "get_current_time", {}, ctx()), false);
});

test("text: pattern survives circular references", () => {
  const r = rule({ toolName: "*", pattern: "text:目标词" });
  const circular: Record<string, unknown> = { nested: { value: "目标词" } };
  circular.self = circular;
  assert.equal(matchPermissionRule(r, "write_file", circular, ctx()), true);
});

test("text: pattern matches values in arrays and nested objects", () => {
  const r = rule({ toolName: "*", pattern: "text:机密" });
  assert.equal(matchPermissionRule(r, "write_file", { items: [{ name: "文档" }, { name: "机密资料" }] }, ctx()), true);
});

test("pattern on non-bash non-file tool matches any input", () => {
  const r = rule({ toolName: "agent", pattern: "anything" });
  assert.equal(matchPermissionRule(r, "agent", { subagent_type: "researcher" }, ctx()), true);
});
