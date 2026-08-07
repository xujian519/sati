import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { applyMethodologyInjection } from "../../../src/agent/loop/methodologyInjection.js";

const SYSTEM = "You are Sati.";

function userMessage(blocks: Array<{ type: "text"; text: string }>): CanonicalMessage {
  return { role: "user", content: blocks };
}

function assistantMessage(): CanonicalMessage {
  return { role: "assistant", content: [] };
}

test("无 inject 回调时原样返回 systemPrompt", () => {
  const messages = [userMessage([{ type: "text", text: "hello" }])];
  assert.equal(applyMethodologyInjection(SYSTEM, messages, undefined), SYSTEM);
});

test("消息数组为空时原样返回", () => {
  assert.equal(
    applyMethodologyInjection(SYSTEM, [], () => "EXTRA"),
    SYSTEM,
  );
});

test("没有 user 文本消息时原样返回（跳过 assistant/tool）", () => {
  const messages = [assistantMessage()];
  assert.equal(
    applyMethodologyInjection(SYSTEM, messages, () => "EXTRA"),
    SYSTEM,
  );
});

test("命中第一条 user 文本时追加 addendum", () => {
  const messages = [userMessage([{ type: "text", text: "写一份权利要求" }])];
  assert.equal(
    applyMethodologyInjection(SYSTEM, messages, text => `methodology: ${text}`),
    `${SYSTEM}\n\nmethodology: 写一份权利要求`,
  );
});

test("回调返回 null 时原样返回", () => {
  const messages = [userMessage([{ type: "text", text: "hi" }])];
  assert.equal(
    applyMethodologyInjection(SYSTEM, messages, () => null),
    SYSTEM,
  );
});

test("回调返回空字符串时原样返回", () => {
  const messages = [userMessage([{ type: "text", text: "hi" }])];
  assert.equal(
    applyMethodologyInjection(SYSTEM, messages, () => ""),
    SYSTEM,
  );
});

test("多条 user 消息时取第一条有文本的", () => {
  const messages = [userMessage([{ type: "text", text: "第一条" }]), userMessage([{ type: "text", text: "第二条" }])];
  const result = applyMethodologyInjection(SYSTEM, messages, text => `got:${text}`);
  assert.equal(result, `${SYSTEM}\n\ngot:第一条`);
});

test("单条 user 消息多个文本块按 \\n 拼接后传给回调", () => {
  const messages = [
    userMessage([
      { type: "text", text: "甲" },
      { type: "text", text: "乙" },
    ]),
  ];
  const result = applyMethodologyInjection(SYSTEM, messages, text => `got:${text}`);
  assert.equal(result, `${SYSTEM}\n\ngot:甲\n乙`);
});
