import test from "node:test";
import assert from "node:assert/strict";
import { groupConsecutiveTools } from "../../src/adapters/channel/tui/app/groupConsecutiveTools.js";
import type { TuiMessage } from "../../src/adapters/channel/tui/app/types.js";

function tool(name: string, text = "ok"): TuiMessage {
  return { role: "tool", text, ok: true, toolCallId: `tc-${name}-${Math.random()}`, toolName: name };
}

test("groupConsecutiveTools: 3+ same-name tools are grouped", () => {
  const messages: TuiMessage[] = [
    tool("read_file", "content1"),
    tool("read_file", "content2"),
    tool("read_file", "content3"),
  ];
  const items = groupConsecutiveTools(messages);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.type, "tool_group");
  if (items[0]!.type === "tool_group") {
    assert.equal(items[0]!.toolName, "read_file");
    assert.equal(items[0]!.messages.length, 3);
  }
});

test("groupConsecutiveTools: 2 same-name tools are NOT grouped", () => {
  const messages: TuiMessage[] = [
    tool("read_file"),
    tool("read_file"),
  ];
  const items = groupConsecutiveTools(messages);
  assert.equal(items.length, 2);
  assert.ok(items.every((i: { type: string }) => i.type === "single"));
});

test("groupConsecutiveTools: mixed tools not grouped", () => {
  const messages: TuiMessage[] = [
    tool("read_file"),
    tool("bash"),
    tool("read_file"),
  ];
  const items = groupConsecutiveTools(messages);
  assert.equal(items.length, 3);
  assert.ok(items.every((i: { type: string }) => i.type === "single"));
});

test("groupConsecutiveTools: non-tool messages break groups", () => {
  const messages: TuiMessage[] = [
    tool("read_file"),
    tool("read_file"),
    { role: "assistant", text: "Analysis:" },
    tool("read_file"),
    tool("read_file"),
    tool("read_file"),
  ];
  const items = groupConsecutiveTools(messages);
  assert.equal(items.length, 4);
  assert.equal(items[3]!.type, "tool_group");
});

test("groupConsecutiveTools: empty array returns empty", () => {
  assert.deepEqual(groupConsecutiveTools([]), []);
});

test("groupConsecutiveTools: tools without toolName are not grouped", () => {
  const messages: TuiMessage[] = [
    { role: "tool", text: "ok", ok: true },
    { role: "tool", text: "ok", ok: true },
    { role: "tool", text: "ok", ok: true },
  ];
  const items = groupConsecutiveTools(messages);
  assert.equal(items.length, 3);
  assert.ok(items.every((i: { type: string }) => i.type === "single"));
});

test("groupConsecutiveTools: group preserves startIndex", () => {
  const messages: TuiMessage[] = [
    { role: "user", text: "hello" },
    tool("read_file"),
    tool("read_file"),
    tool("read_file"),
  ];
  const items = groupConsecutiveTools(messages);
  assert.equal(items.length, 2);
  if (items[1]!.type === "tool_group") {
    assert.equal(items[1]!.startIndex, 1);
  }
});
