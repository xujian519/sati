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

// ---------------------------------------------------------------------------
// fail-safe（#361）：方法论注入是辅助路径，组件抛错不得阻断整轮请求
// ---------------------------------------------------------------------------

test("computeMethodologyAddendum：inject 抛错时降级为无 addendum 并告警（不阻断请求）", () => {
  const messages = [userMessage([{ type: "text", text: "这个结构的强度和重量存在矛盾" }])];
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  let addendum: string | undefined;
  try {
    addendum = computeMethodologyAddendum(messages, () => {
      throw new Error("triz-matrix.json ENOENT");
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(addendum, undefined, "组件抛错必须被吞掉，不得让模型请求构造失败");
  assert.equal(warns.length, 1, `应恰好告警一次: ${warns.join("; ")}`);
  assert.ok(warns[0]!.includes("triz-matrix.json ENOENT"), `告警应带原始原因: ${warns[0]}`);
});

test("computeMethodologyAddendum：inject 抛非 Error 值同样被降级", () => {
  const messages = [userMessage([{ type: "text", text: "hi" }])];
  const originalWarn = console.warn;
  console.warn = () => {};
  let addendum: string | undefined;
  try {
    addendum = computeMethodologyAddendum(messages, () => {
      throw "plain string throw";
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(addendum, undefined);
});

test("computeMethodologyAddendum：一次失败不影响后续请求正常注入", () => {
  const messages = [userMessage([{ type: "text", text: "写一份权利要求" }])];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    computeMethodologyAddendum(messages, () => {
      throw new Error("boom");
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(
    computeMethodologyAddendum(messages, text => `methodology: ${text}`),
    "methodology: 写一份权利要求",
  );
});
