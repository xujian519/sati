import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { extractLastUserMessage } from "../../../src/router/tokenSaver/extractLastUserMessage.js";

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

test("空消息数组返回 undefined", () => {
  assert.equal(extractLastUserMessage([]), undefined);
});

test("只有 assistant 消息时返回 undefined", () => {
  assert.equal(extractLastUserMessage([textMessage("assistant", "hi")]), undefined);
});

test("user 消息只有非文本块时返回 undefined", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [{ type: "thinking", text: "思考" }],
  };
  assert.equal(extractLastUserMessage([message]), undefined);
});

test("单条 user 文本消息返回文本", () => {
  assert.equal(extractLastUserMessage([textMessage("user", "请分析权利要求")]), "请分析权利要求");
});

test("从后往前取最后一条有文本的 user 消息（跳过末尾 assistant/tool）", () => {
  const messages = [
    textMessage("user", "第一条"),
    textMessage("assistant", "回复"),
    textMessage("user", "第二条"),
    textMessage("assistant", "继续"),
  ];
  assert.equal(extractLastUserMessage(messages), "第二条");
});

test("单条 user 消息多个文本块按换行拼接", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      { type: "text", text: "甲" },
      { type: "text", text: "乙" },
    ],
  };
  assert.equal(extractLastUserMessage([message]), "甲\n乙");
});

test("末尾 user 消息无文本时向前查找", () => {
  const emptyUser: CanonicalMessage = { role: "user", content: [{ type: "thinking", text: "x" }] };
  const messages = [textMessage("user", "有效文本"), textMessage("assistant", "回复"), emptyUser];
  assert.equal(extractLastUserMessage(messages), "有效文本");
});

test("返回文本经过 trim", () => {
  assert.equal(extractLastUserMessage([textMessage("user", "  带空白的文本  ")]), "带空白的文本");
});
