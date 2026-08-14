import assert from "node:assert/strict";
import test from "node:test";
import {
  addEmptyReasoningContentMarkers,
  appendPlanModeReminder,
  markCompactReplacementMessages,
  normalizeMessagesForModelRequest,
  removeTransientPromptsById,
  splitTransientPrompts,
  stripImagesFromMessages,
  stripTrailingErrorPair,
  truncateHeadKeepRatio,
} from "../../../src/agent/loop/messages.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

/**
 * AgentLoop 消息工具纯函数行为基线测试（拆解专项）。
 *
 * 迁移自 AgentLoop.ts 的确定性消息变换，测试锁定迁移前后行为一致。
 */

const text = (role: CanonicalMessage["role"], content: string): CanonicalMessage => ({
  role,
  content: [{ type: "text", text: content }],
});

test("normalizeMessagesForModelRequest：合并相邻无工具调用的 assistant 消息", () => {
  const messages: CanonicalMessage[] = [
    text("user", "你好"),
    text("assistant", "第一段"),
    text("assistant", "第二段"),
    { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: [{ type: "text", text: "结果" }] }] },
  ];
  const out = normalizeMessagesForModelRequest(messages);
  assert.equal(out.length, 3, "相邻 assistant 应合并为一条");
  const merged = out[1]!;
  assert.equal(merged.role, "assistant");
  assert.deepEqual(
    merged.content.map(block => (block.type === "text" ? block.text : "")),
    ["第一段", "第二段"],
  );
});

test("normalizeMessagesForModelRequest：跳过空 assistant 消息", () => {
  const messages: CanonicalMessage[] = [
    text("user", "问"),
    { role: "assistant", content: [] },
    text("assistant", "回答"),
  ];
  const out = normalizeMessagesForModelRequest(messages);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.role, "user");
  assert.equal(out[1]!.role, "assistant");
});

test("normalizeMessagesForModelRequest：含工具调用的 assistant 不合并", () => {
  const withTool: CanonicalMessage = {
    role: "assistant",
    content: [{ type: "tool_call", id: "t1", name: "patent_search", input: {} }],
  };
  const out = normalizeMessagesForModelRequest([text("assistant", "先说"), withTool]);
  assert.equal(out.length, 2);
});

test("stripTrailingErrorPair：移除末尾残缺 assistant+tool_result 对", () => {
  const messages: CanonicalMessage[] = [
    text("user", "问"),
    text("assistant", "正常回复"),
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "x", content: [{ type: "text", text: "" }] }],
    },
  ];
  const out = stripTrailingErrorPair(messages);
  assert.equal(out.length, 1, "应移除整个残缺对（tool_result + 前置 assistant）");
  assert.equal(out[0]!.role, "user");
});

test("stripTrailingErrorPair：末尾 assistant 片段也会被移除（恢复语义）", () => {
  const messages: CanonicalMessage[] = [text("user", "问"), text("assistant", "答")];
  const out = stripTrailingErrorPair(messages);
  assert.equal(out.length, 1, "末尾 assistant 视为未完成片段移除");
  assert.equal(out[0]!.role, "user");
});

test("stripTrailingErrorPair：仅 user 消息时原样返回", () => {
  const messages: CanonicalMessage[] = [text("user", "问")];
  assert.deepEqual(stripTrailingErrorPair(messages), messages);
});

test("stripImagesFromMessages：图片块替换为文本占位", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [{ type: "image", source: "url", data: "data:image/png;base64,AAAA", mimeType: "image/png" }],
    },
  ];
  const out = stripImagesFromMessages(messages);
  assert.equal(out[0]!.content[0]!.type, "text");
  assert.match((out[0]!.content[0] as { text: string }).text, /Image removed/);
});

test("truncateHeadKeepRatio：保留尾部比例并钳制范围", () => {
  const messages = Array.from({ length: 10 }, (_, i) => text("user", `m${i}`));
  const out = truncateHeadKeepRatio(messages, 0.3);
  assert.equal(out.length, 3);
  assert.equal((out[0]!.content[0] as { text: string }).text, "m7");
  // 越界比例钳制。
  assert.equal(truncateHeadKeepRatio(messages, 2).length, 10);
  assert.equal(truncateHeadKeepRatio(messages, 0).length, 1);
});

test("markCompactReplacementMessages：全部消息标记 compactReplacement", () => {
  const messages = [text("user", "a"), text("assistant", "b")];
  const out = markCompactReplacementMessages(messages);
  assert.ok(out.every(m => m.metadata?.compactReplacement === true));
});

test("addEmptyReasoningContentMarkers：为无 reasoning 的 assistant 消息补 thinking 块", () => {
  const messages: CanonicalMessage[] = [text("user", "问"), text("assistant", "答")];
  const out = addEmptyReasoningContentMarkers(messages);
  const assistant = out[1]!;
  assert.equal(assistant.content[0]!.type, "thinking");
  const thinking = assistant.content[0] as { reasoningContent: string };
  assert.equal(thinking.reasoningContent, "");
});

test("appendPlanModeReminder：追加 plan 模式提醒（synthetic）", () => {
  const messages = [text("user", "问")];
  const out = appendPlanModeReminder(messages);
  assert.equal(out.length, 2);
  const reminder = out[1]!;
  assert.equal(reminder.role, "user");
  assert.equal(reminder.metadata?.synthetic, true);
  assert.equal(reminder.metadata?.purpose, "plan_mode_reminder");
  assert.match((reminder.content[0] as { text: string }).text, /Plan mode is active/);
});

test("removeTransientPromptsById：移除匹配的 transient 提示", () => {
  const transient: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: "继续" }],
    metadata: { transient: true, transientId: "t-1", synthetic: true },
  };
  const messages = [transient, text("user", "正常")];
  const out = removeTransientPromptsById(messages, new Set(["t-1"]));
  assert.equal(out.length, 1);
  assert.equal((out[0]!.content[0] as { text: string }).text, "正常");
});

test("splitTransientPrompts：分离 transient 提示与持久消息（保序）", () => {
  const transient: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: "恢复提示" }],
    metadata: { transient: true, transientId: "t-1", synthetic: true },
  };
  const messages = [text("user", "第一"), transient, text("assistant", "第二"), text("user", "第三")];
  const { persistent, transient: prompts } = splitTransientPrompts(messages);
  assert.deepEqual(
    persistent.map(message => (message.content[0] as { text: string }).text),
    ["第一", "第二", "第三"],
    "persistent 保持原顺序，剔除 transient",
  );
  assert.deepEqual(
    prompts.map(message => (message.content[0] as { text: string }).text),
    ["恢复提示"],
    "transient 单独收集，供压缩产物后追加",
  );
});
