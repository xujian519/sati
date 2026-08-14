import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage } from "../../../src/model/index.js";
import {
  applyMethodologyAddendum,
  computeMethodologyAddendum,
  findFirstUserText,
} from "../../../src/agent/loop/methodologyInjection.js";

const SYSTEM = "You are Sati.";

function userMessage(blocks: Array<{ type: "text"; text: string }>): CanonicalMessage {
  return { role: "user", content: blocks };
}

function assistantMessage(): CanonicalMessage {
  return { role: "assistant", content: [] };
}

test("computeMethodologyAddendum：无 inject 回调时返回 undefined", () => {
  const messages = [userMessage([{ type: "text", text: "hello" }])];
  assert.equal(computeMethodologyAddendum(messages, undefined), undefined);
});

test("computeMethodologyAddendum：消息数组为空时返回 undefined", () => {
  assert.equal(
    computeMethodologyAddendum([], () => "EXTRA"),
    undefined,
  );
});

test("computeMethodologyAddendum：没有 user 文本消息时返回 undefined", () => {
  assert.equal(
    computeMethodologyAddendum([assistantMessage()], () => "EXTRA"),
    undefined,
  );
});

test("computeMethodologyAddendum：命中第一条 user 文本", () => {
  const messages = [userMessage([{ type: "text", text: "写一份权利要求" }])];
  assert.equal(
    computeMethodologyAddendum(messages, text => `methodology: ${text}`),
    "methodology: 写一份权利要求",
  );
});

test("computeMethodologyAddendum：回调返回 null / 空字符串时视为无 addendum", () => {
  const messages = [userMessage([{ type: "text", text: "hi" }])];
  assert.equal(
    computeMethodologyAddendum(messages, () => null),
    undefined,
  );
  assert.equal(
    computeMethodologyAddendum(messages, () => ""),
    undefined,
  );
});

test("computeMethodologyAddendum：多条 user 消息时取第一条有文本的", () => {
  const messages = [userMessage([{ type: "text", text: "第一条" }]), userMessage([{ type: "text", text: "第二条" }])];
  assert.equal(
    computeMethodologyAddendum(messages, text => `got:${text}`),
    "got:第一条",
  );
});

test("computeMethodologyAddendum：单条 user 消息多个文本块按 \\n 拼接", () => {
  const messages = [
    userMessage([
      { type: "text", text: "甲" },
      { type: "text", text: "乙" },
    ]),
  ];
  assert.equal(
    computeMethodologyAddendum(messages, text => `got:${text}`),
    "got:甲\n乙",
  );
});

test("computeMethodologyAddendum：回调只被调用一次（单次计算供落库与拼 prompt 复用）", () => {
  let calls = 0;
  const messages = [userMessage([{ type: "text", text: "hello" }])];
  const addendum = computeMethodologyAddendum(messages, text => {
    calls += 1;
    return `got:${text}`;
  });
  assert.equal(addendum, "got:hello");
  assert.equal(calls, 1, "inject 回调必须且只执行一次");
});

test("applyMethodologyAddendum：空 addendum 原样返回", () => {
  assert.equal(applyMethodologyAddendum(SYSTEM, undefined), SYSTEM);
  assert.equal(applyMethodologyAddendum(SYSTEM, ""), SYSTEM);
});

test("applyMethodologyAddendum：追加 addendum 到 system prompt", () => {
  assert.equal(applyMethodologyAddendum(SYSTEM, "methodology: 写权利要求"), `${SYSTEM}\n\nmethodology: 写权利要求`);
});

test("findFirstUserText：取第一条 user 文本消息并拼接多文本块", () => {
  assert.equal(
    findFirstUserText([
      assistantMessage(),
      userMessage([
        { type: "text", text: "甲" },
        { type: "text", text: "乙" },
      ]),
    ]),
    "甲\n乙",
  );
  assert.equal(findFirstUserText([assistantMessage()]), undefined);
});
