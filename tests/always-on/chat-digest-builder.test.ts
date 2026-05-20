import assert from "node:assert/strict";
import test from "node:test";
import { extractAllUserPrompts } from "../../src/always-on/context/ChatDigestBuilder.js";

const accepted = (text: string) =>
  JSON.stringify({ type: "accepted_input", messages: [{ content: [{ type: "text", text }] }] });

const metadata = (title: string) =>
  JSON.stringify({ type: "session_metadata", title });

test("extractAllUserPrompts extracts text from accepted_input lines", () => {
  const source = [
    metadata("test session"),
    accepted("first user message"),
    accepted("second user message"),
  ].join("\n");

  const result = extractAllUserPrompts(source, 10, 500);
  assert.deepStrictEqual(result, ["first user message", "second user message"]);
});

test("extractAllUserPrompts truncates long messages", () => {
  const longMsg = "a".repeat(600);
  const source = accepted(longMsg);

  const result = extractAllUserPrompts(source, 10, 100);
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 103); // 100 chars + "..."
  assert.ok(result[0].endsWith("..."));
});

test("extractAllUserPrompts respects maxPrompts limit", () => {
  const source = [
    accepted("msg 1"),
    accepted("msg 2"),
    accepted("msg 3"),
  ].join("\n");

  const result = extractAllUserPrompts(source, 2, 500);
  assert.deepStrictEqual(result, ["msg 1", "msg 2"]);
});

test("extractAllUserPrompts deduplicates identical messages from head/tail overlap", () => {
  const line = accepted("duplicate message");
  const source = `${line}\n${line}`;

  const result = extractAllUserPrompts(source, 10, 500);
  assert.deepStrictEqual(result, ["duplicate message"]);
});

test("extractAllUserPrompts skips non-accepted_input lines", () => {
  const source = [
    JSON.stringify({ type: "assistant_message", content: "hello" }),
    accepted("only user message"),
    JSON.stringify({ type: "turn_result", turnId: "t1" }),
  ].join("\n");

  const result = extractAllUserPrompts(source, 10, 500);
  assert.deepStrictEqual(result, ["only user message"]);
});

test("extractAllUserPrompts skips malformed lines", () => {
  const source = [
    "not valid json",
    accepted("valid message"),
    '{"type":"accepted_input",',
  ].join("\n");

  const result = extractAllUserPrompts(source, 10, 500);
  assert.deepStrictEqual(result, ["valid message"]);
});

test("extractAllUserPrompts returns empty for source with no accepted_input", () => {
  const source = [
    metadata("title"),
    JSON.stringify({ type: "assistant_message", text: "hi" }),
  ].join("\n");

  const result = extractAllUserPrompts(source, 10, 500);
  assert.deepStrictEqual(result, []);
});
