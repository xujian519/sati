/**
 * 防死循环软提醒测试（阶段四 T6.2）。
 *
 * 覆盖：RepeatTracker 连续/重置语义、toolCallKey 稳定与 raw 剥离、
 * buildRepeatReminderMessage 形状（transient + purpose + 计数）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRepeatReminderMessage,
  REPEAT_REMINDER_THRESHOLD,
  RepeatTracker,
  toolCallKey,
} from "../../../src/agent/loop/repeatToolReminder.js";

test("RepeatTracker：同键累加、异键重置", () => {
  const tracker = new RepeatTracker();
  const keyA = toolCallKey("read_file", { filePath: "/a.md" });
  const keyB = toolCallKey("read_file", { filePath: "/b.md" });
  assert.equal(tracker.record(keyA), 1);
  assert.equal(tracker.record(keyA), 2);
  assert.equal(tracker.record(keyB), 1);
  assert.equal(tracker.record(keyA), 1);
});

test("toolCallKey：同参数同键、raw 剥离不影响键", () => {
  const args = { filePath: "/a.md", limit: 10 };
  const withRaw = { filePath: "/a.md", limit: 10, raw: { internal: true } };
  assert.equal(toolCallKey("read_file", args), toolCallKey("read_file", withRaw));
  assert.notEqual(toolCallKey("read_file", args), toolCallKey("read_file", { filePath: "/b.md" }));
});

test("buildRepeatReminderMessage：transient synthetic 且含计数", () => {
  const message = buildRepeatReminderMessage("read_file", 3);
  assert.equal(message.role, "user");
  assert.equal(message.metadata?.synthetic, true);
  assert.equal(message.metadata?.transient, true);
  assert.equal(message.metadata?.purpose, "repeat_tool_reminder");
  const text = message.content[0]?.type === "text" ? message.content[0].text : "";
  assert.ok(text.includes("3") && text.includes("read_file"));
});

test("阈值常量为 3", () => {
  assert.equal(REPEAT_REMINDER_THRESHOLD, 3);
});
