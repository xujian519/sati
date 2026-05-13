import test from "node:test";
import assert from "node:assert/strict";
import { formatToolSummary } from "../../src/adapters/channel/tui/app/formatToolSummary.js";

test("formatToolSummary: test passing detection (no failures)", () => {
  const result = formatToolSummary("bash", "npm test", 42, 0, true, "42 passing (3s)");
  assert.ok(result.includes("42 passed"));
  assert.ok(!result.includes("failed"));
});

test("formatToolSummary: test passing + failing detection", () => {
  const result = formatToolSummary("bash", "npm test", 50, 0, true, "40 passing\n10 failing");
  assert.ok(result.includes("40 passed"));
  assert.ok(result.includes("10 failed"));
});

test("formatToolSummary: TypeScript error detection", () => {
  const preview = "src/main.ts(5,3): error TS2304: Cannot find name 'foo'\nsrc/main.ts(10,1): error TS2322: Type mismatch";
  const result = formatToolSummary("bash", "tsc", 20, 0, true, preview);
  assert.ok(result.includes("error"));
});

test("formatToolSummary: error status shows first line", () => {
  const result = formatToolSummary("bash", "ls", 5, 0, false, "No such file or directory\ndetails");
  assert.ok(result.includes("No such file or directory"));
});

test("formatToolSummary: default fallback shows line count", () => {
  const result = formatToolSummary("read_file", "src/main.ts", 156, 0, true, "import { foo }...");
  assert.ok(result.includes("156 lines"));
  assert.ok(result.includes("read_file"));
  assert.ok(result.includes("src/main.ts"));
});

test("formatToolSummary: tool without argsHint uses just toolName", () => {
  const result = formatToolSummary("read_file", undefined, 42, 0, true, "content here");
  assert.ok(result.startsWith("read_file"));
  assert.ok(result.includes("42 lines"));
});

test("formatToolSummary: non-bash tool with error shows first line", () => {
  const result = formatToolSummary("write_file", "foo.ts", 3, 0, false, "Permission denied");
  assert.ok(result.includes("Permission denied"));
});
