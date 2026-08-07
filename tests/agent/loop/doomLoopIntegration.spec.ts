import assert from "node:assert/strict";
import test from "node:test";
import { textFromMessage, type CanonicalMessage, type CanonicalToolCall } from "../../../src/model/index.js";
import type { SatiToolResult } from "../../../src/tool/index.js";
import { DoomLoop, TextRepetitionDetector, ToolCallLoopDetector } from "../../../src/agent/loop/doomLoop.js";
import type { DoomLoopSignal } from "../../../src/agent/loop/doomLoop.js";
import {
  doomLoopSignalEvent,
  emitDoomLoopSignals,
  observeModelCall,
  observeToolResults,
  recordModelCall,
  recordToolResults,
} from "../../../src/agent/loop/doomLoopIntegration.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolCall(name: string, input: unknown): CanonicalToolCall {
  return { id: "c1", name, input } as CanonicalToolCall;
}

function successResult(text: string): SatiToolResult {
  return {
    type: "success",
    toolCallId: "c1",
    toolName: "read_file",
    content: [{ type: "text", text }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
}

// ---------------------------------------------------------------------------
// 纯观测（observe*）
// ---------------------------------------------------------------------------

test("未配置 DoomLoop 时两个 observe 都返回 undefined", () => {
  assert.equal(observeModelCall(undefined, userMessage("hi")), undefined);
  assert.equal(observeToolResults(undefined, [toolCall("read_file", {})], [successResult("ok")]), undefined);
});

test("observeModelCall：文本复读命中返回 signal，turn 正确", () => {
  const d = new DoomLoop([new TextRepetitionDetector(3)]);
  d.reset(7);
  const msg = userMessage("重复的模型输出文本");
  observeModelCall(d, msg);
  observeModelCall(d, msg);
  const observed = observeModelCall(d, msg);
  assert.equal(observed?.turn, 7);
  assert.equal(observed?.signals.length, 1);
  assert.equal(observed?.signals[0]?.detector, "textRepetition");
});

test("observeModelCall：未命中时返回空 signals", () => {
  const d = new DoomLoop([new TextRepetitionDetector(3)]);
  d.reset(1);
  const observed = observeModelCall(d, userMessage("仅一次"));
  assert.equal(observed?.signals.length, 0);
  assert.equal(observed?.turn, 1);
});

test("observeToolResults：同参重复命中返回 signal", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)]);
  d.reset(3);
  const call = toolCall("read_file", { path: "/a" });
  const result = successResult("ok");
  observeToolResults(d, [call], [result]);
  observeToolResults(d, [call], [result]);
  const observed = observeToolResults(d, [call], [result]);
  assert.equal(observed?.turn, 3);
  assert.equal(observed?.signals.length, 1);
  assert.equal(observed?.signals[0]?.detector, "toolCallLoop");
});

test("observeToolResults：参数不同不命中，返回空 signals", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)]);
  d.reset(1);
  observeToolResults(d, [toolCall("read_file", { path: "/a" })], [successResult("ok")]);
  const observed = observeToolResults(d, [toolCall("read_file", { path: "/b" })], [successResult("ok")]);
  assert.equal(observed?.signals.length, 0);
});

test("observeToolResults：缺失 result 时不崩溃且不产生重复信号", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)]);
  d.reset(1);
  const call = toolCall("read_file", { path: "/a" });
  observeToolResults(d, [call], [successResult("ok")]);
  const observed = observeToolResults(d, [call], []);
  assert.equal(observed?.signals.length, 0);
  assert.equal(observed?.turn, 1);
});

// ---------------------------------------------------------------------------
// 事件映射与发射（doomLoopSignalEvent / emitDoomLoopSignals）
// ---------------------------------------------------------------------------

test("doomLoopSignalEvent：信号字段正确映射到事件", () => {
  const signal: DoomLoopSignal = {
    detector: "textRepetition",
    reason: "text repeated 3 times",
    turn: 5,
    fatal: true,
  };
  const event = doomLoopSignalEvent(signal, { sessionId: "s1", turnId: "t1" }, 5);
  assert.deepEqual(event, {
    type: "doomloop_signal",
    sessionId: "s1",
    turnId: "t1",
    detector: "textRepetition",
    reason: "text repeated 3 times",
    turn: 5,
    fatal: true,
  });
});

test("emitDoomLoopSignals：未配置 emitter 时不崩溃且返回 undefined", () => {
  const signal: DoomLoopSignal = { detector: "textRepetition", reason: "r", turn: 1, fatal: false };
  assert.equal(emitDoomLoopSignals([signal], { sessionId: "s", turnId: "t" }, 1, undefined), undefined);
});

test("emitDoomLoopSignals：每个信号发射一个事件", () => {
  const signals: DoomLoopSignal[] = [
    { detector: "textRepetition", reason: "r1", turn: 1, fatal: false },
    { detector: "emptyResult", reason: "r2", turn: 1, fatal: false },
  ];
  const emitted: string[] = [];
  emitDoomLoopSignals(signals, { sessionId: "s1", turnId: "t1" }, 1, event => emitted.push(event.type));
  assert.deepEqual(emitted, ["doomloop_signal", "doomloop_signal"]);
});

test("emitDoomLoopSignals：fatal 信号返回 reason", () => {
  const signal: DoomLoopSignal = { detector: "circuitBreaker", reason: "too many calls", turn: 2, fatal: true };
  assert.equal(emitDoomLoopSignals([signal], { sessionId: "s1", turnId: "t1" }, 2), "too many calls");
});

test("emitDoomLoopSignals：非 fatal 信号返回 undefined", () => {
  const signal: DoomLoopSignal = { detector: "textRepetition", reason: "warning", turn: 1, fatal: false };
  assert.equal(emitDoomLoopSignals([signal], { sessionId: "s", turnId: "t" }, 1), undefined);
});

// ---------------------------------------------------------------------------
// 组合（record*）——AgentLoop 实际调用的入口
// ---------------------------------------------------------------------------

test("recordModelCall：未配置 DoomLoop 时返回 undefined", () => {
  assert.equal(recordModelCall(undefined, userMessage("hi"), { sessionId: "s", turnId: "t" }), undefined);
});

test("recordModelCall：fatal 命中返回 reason 且发射事件", () => {
  const d = new DoomLoop([new TextRepetitionDetector(3)], { fatal: true });
  d.reset(1);
  const msg = userMessage("重复输出");
  const emitted: string[] = [];
  assert.equal(
    recordModelCall(d, msg, { sessionId: "s1", turnId: "t1" }, e => emitted.push(e.type)),
    undefined,
  );
  assert.equal(
    recordModelCall(d, msg, { sessionId: "s1", turnId: "t1" }, e => emitted.push(e.type)),
    undefined,
  );
  const reason = recordModelCall(d, msg, { sessionId: "s1", turnId: "t1" }, e => emitted.push(e.type));
  assert.equal(reason, "连续 3 轮输出末尾逐字相同（疑似复读）");
  // 仅命中时发事件：前两次 signals 为空，第三次触发发 1 个
  assert.deepEqual(emitted, ["doomloop_signal"]);
});

test("recordToolResults：同参重复 fatal 命中返回 reason", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)], { fatal: true });
  d.reset(1);
  const call = toolCall("read_file", { path: "/a" });
  const result = successResult("ok");
  recordToolResults(d, [call], [result], { sessionId: "s1", turnId: "t1" });
  recordToolResults(d, [call], [result], { sessionId: "s1", turnId: "t1" });
  const reason = recordToolResults(d, [call], [result], { sessionId: "s1", turnId: "t1" });
  assert.equal(reason, "连续 3 次完全相同的工具调用: read_file");
});

test("recordToolResults：未配置 DoomLoop 时返回 undefined", () => {
  assert.equal(
    recordToolResults(undefined, [toolCall("read_file", {})], [successResult("ok")], { sessionId: "s", turnId: "t" }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

test("textFromMessage：拼接文本块、跳过非文本块", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      { type: "thinking", text: "思考过程" },
      { type: "text", text: "甲" },
      { type: "text", text: "乙" },
    ],
  };
  assert.equal(textFromMessage(message), "甲\n乙");
});
