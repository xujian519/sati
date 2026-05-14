import test from "node:test";
import assert from "node:assert/strict";
import { extractDetail } from "../../src/adapters/channel/tui/app/PermissionPrompt.js";

test("extractDetail: bash returns command", () => {
  assert.equal(extractDetail("bash", { command: "rm -rf /" }), "rm -rf /");
});

test("extractDetail: bash returns null for missing command", () => {
  assert.equal(extractDetail("bash", {}), null);
  assert.equal(extractDetail("bash", null), null);
});

test("extractDetail: writeFile returns path", () => {
  assert.equal(extractDetail("writeFile", { path: "/tmp/foo.ts" }), "/tmp/foo.ts");
  assert.equal(extractDetail("write_file", { file_path: "/tmp/bar.ts" }), "/tmp/bar.ts");
});

test("extractDetail: editFile returns path", () => {
  assert.equal(extractDetail("editFile", { filePath: "/src/main.ts" }), "/src/main.ts");
  assert.equal(extractDetail("edit_file", { path: "/src/app.ts" }), "/src/app.ts");
  assert.equal(extractDetail("str_replace_editor", { path: "/a/b.ts" }), "/a/b.ts");
});

test("extractDetail: agent returns description truncated to 80 chars", () => {
  const short = "Run tests";
  assert.equal(extractDetail("agent", { description: short }), short);
  const long = "A".repeat(100);
  assert.equal(extractDetail("agent", { description: long })!.length, 80);
});

test("extractDetail: agent falls back to task and prompt", () => {
  assert.equal(extractDetail("agent", { task: "do something" }), "do something");
  assert.equal(extractDetail("agent", { prompt: "help me" }), "help me");
});

test("extractDetail: web_search returns query", () => {
  assert.equal(extractDetail("web_search", { query: "hello world" }), "hello world");
  assert.equal(extractDetail("webSearch", { search_term: "foo bar" }), "foo bar");
});

test("extractDetail: web_fetch returns url", () => {
  assert.equal(extractDetail("web_fetch", { url: "https://example.com" }), "https://example.com");
  assert.equal(extractDetail("webFetch", { url: "https://x.com/api" }), "https://x.com/api");
});

test("extractDetail: unknown tool returns first string value", () => {
  assert.equal(extractDetail("custom_tool", { foo: 42, bar: "hello" }), "hello");
});

test("extractDetail: unknown tool with no string value returns null", () => {
  assert.equal(extractDetail("custom_tool", { foo: 42 }), null);
  assert.equal(extractDetail("custom_tool", {}), null);
});
