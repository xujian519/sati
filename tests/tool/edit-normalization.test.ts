import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuotes,
  stripTrailingWhitespace,
  findActualString,
  normalizeEditInput,
} from "../../src/tool/builtin/filesystem/editNormalization.js";

test("normalizeQuotes converts curly quotes to straight", () => {
  assert.equal(normalizeQuotes("\u2018hello\u2019"), "'hello'");
  assert.equal(normalizeQuotes("\u201CHello\u201D"), '"Hello"');
  assert.equal(normalizeQuotes("plain"), "plain");
  assert.equal(
    normalizeQuotes("\u201Cmixed \u2018nested\u2019\u201D"),
    '"mixed \'nested\'"',
  );
});

test("stripTrailingWhitespace removes per-line trailing spaces", () => {
  assert.equal(stripTrailingWhitespace("a  \nb  \n"), "a\nb\n");
  assert.equal(stripTrailingWhitespace("no trailing"), "no trailing");
  assert.equal(stripTrailingWhitespace("tabs\t\nspaces   \n"), "tabs\nspaces\n");
  assert.equal(stripTrailingWhitespace(""), "");
});

test("stripTrailingWhitespace preserves CRLF line endings", () => {
  assert.equal(stripTrailingWhitespace("a  \r\nb  \r\n"), "a\r\nb\r\n");
});

test("findActualString: exact match", () => {
  assert.equal(findActualString("hello world", "world"), "world");
});

test("findActualString: returns null for no match", () => {
  assert.equal(findActualString("hello world", "xyz"), null);
});

test("findActualString: curly quote normalization", () => {
  const file = 'She said \u201CHello\u201D';
  const search = 'She said "Hello"';
  const actual = findActualString(file, search);
  assert.ok(actual);
  assert.equal(actual, 'She said \u201CHello\u201D');
});

test("findActualString: prefers exact match over normalized", () => {
  const file = '"straight" and \u201Ccurly\u201D';
  assert.equal(findActualString(file, '"straight"'), '"straight"');
});

test("normalizeEditInput strips trailing whitespace for non-markdown", () => {
  const result = normalizeEditInput("/foo/bar.ts", "old", "new   ");
  assert.equal(result.newString, "new");
  assert.equal(result.oldString, "old");
});

test("normalizeEditInput preserves trailing whitespace for markdown", () => {
  const result = normalizeEditInput("/foo/bar.md", "old", "new   ");
  assert.equal(result.newString, "new   ");
});

test("normalizeEditInput preserves trailing whitespace for .mdx", () => {
  const result = normalizeEditInput("/docs/page.mdx", "old", "new   ");
  assert.equal(result.newString, "new   ");
});
