import test from "node:test";
import assert from "node:assert/strict";
import { truncateForDisplay, countVisualLines } from "../../src/adapters/channel/tui/app/truncate.js";

test("truncateForDisplay: single line passes through", () => {
  const result = truncateForDisplay("hello world", 80);
  assert.equal(result, "hello world");
});

test("truncateForDisplay: 3 lines preserved exactly", () => {
  const input = "line1\nline2\nline3";
  const result = truncateForDisplay(input, 80);
  assert.equal(result, input);
});

test("truncateForDisplay: 4 lines preserved (4-line special case)", () => {
  const input = "line1\nline2\nline3\nline4";
  const result = truncateForDisplay(input, 80);
  assert.equal(result, input);
});

test("truncateForDisplay: 5+ lines truncated to 3", () => {
  const input = "line1\nline2\nline3\nline4\nline5";
  const result = truncateForDisplay(input, 80);
  const lines = result.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "line1");
  assert.equal(lines[1], "line2");
  assert.equal(lines[2], "line3");
});

test("truncateForDisplay: empty string returns empty", () => {
  assert.equal(truncateForDisplay("", 80), "");
});

test("truncateForDisplay: trims trailing whitespace", () => {
  const result = truncateForDisplay("hello   \n  ", 80);
  assert.equal(result, "hello");
});

test("truncateForDisplay: long single line wraps and counts correctly", () => {
  const longLine = "a".repeat(200);
  const result = truncateForDisplay(longLine, 80);
  assert.equal(result, longLine);
});

test("truncateForDisplay: very long single line gets truncated", () => {
  const longLine = "a".repeat(1000);
  const result = truncateForDisplay(longLine, 80);
  assert.ok(result.length < longLine.length);
});

test("countVisualLines: simple multiline", () => {
  assert.equal(countVisualLines("a\nb\nc", 80), 3);
});

test("countVisualLines: wrapping lines", () => {
  const longLine = "a".repeat(200);
  assert.equal(countVisualLines(longLine, 80), 3);
});

test("countVisualLines: empty string", () => {
  assert.equal(countVisualLines("", 80), 0);
});

test("truncateForDisplay: ANSI codes do not count as width", () => {
  const ansi = "\x1b[32mgreen text\x1b[0m";
  const result = truncateForDisplay(ansi, 80);
  assert.equal(result, ansi);
});
