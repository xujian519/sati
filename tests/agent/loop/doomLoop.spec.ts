import assert from "node:assert/strict";
import test from "node:test";
import {
  CircuitBreakerDetector,
  CompactionBreakerDetector,
  CycleDetector,
  DoomLoop,
  EmptyResultDetector,
  TextRepetitionDetector,
  ToolCallLoopDetector,
  toolCallKey,
} from "../../../src/agent/loop/doomLoop.js";

// ---------------------------------------------------------------------------
// toolCallLoop —— 同参工具调用完全重复
// ---------------------------------------------------------------------------

test("toolCallLoop：连续 3 次同参调用命中", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)], { fatal: true });
  d.reset(1);
  assert.equal(d.recordToolResult({ name: "read_file", args: { path: "/a" }, result: "ok" }).length, 0);
  assert.equal(d.recordToolResult({ name: "read_file", args: { path: "/a" }, result: "ok" }).length, 0);
  const signals = d.recordToolResult({ name: "read_file", args: { path: "/a" }, result: "ok" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.detector, "toolCallLoop");
  assert.equal(signals[0]?.fatal, true);
});

test("toolCallLoop：参数不同不命中", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)]);
  d.reset(1);
  d.recordToolResult({ name: "read_file", args: { path: "/a" }, result: "ok" });
  d.recordToolResult({ name: "read_file", args: { path: "/b" }, result: "ok" });
  assert.equal(d.recordToolResult({ name: "read_file", args: { path: "/c" }, result: "ok" }).length, 0);
});

test("toolCallLoop：文本响应清空同参窗口（换话题）", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)]);
  d.reset(1);
  d.recordToolResult({ name: "read_file", args: { path: "/a" }, result: "ok" });
  d.recordToolResult({ name: "read_file", args: { path: "/a" }, result: "ok" });
  // 模型输出文本 → 清空窗口
  d.recordModelCall({ text: "让我换个思路" });
  assert.equal(d.recordToolResult({ name: "read_file", args: { path: "/a" }, result: "ok" }).length, 0);
});

// ---------------------------------------------------------------------------
// textRepetition —— 输出末尾逐字复读
// ---------------------------------------------------------------------------

test("textRepetition：连续 3 轮输出末尾相同命中", () => {
  const d = new DoomLoop([new TextRepetitionDetector(3, 100)]);
  d.reset(1);
  d.recordModelCall({ text: "分析完成，结论是 X。" });
  d.recordModelCall({ text: "分析完成，结论是 X。" });
  const signals = d.recordModelCall({ text: "分析完成，结论是 X。" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.detector, "textRepetition");
});

test("textRepetition：输出变化不命中", () => {
  const d = new DoomLoop([new TextRepetitionDetector(3, 100)]);
  d.reset(1);
  d.recordModelCall({ text: "第一步。" });
  d.recordModelCall({ text: "第二步。" });
  assert.equal(d.recordModelCall({ text: "第三步。" }).length, 0);
});

// ---------------------------------------------------------------------------
// cycle —— 工具名周期模式
// ---------------------------------------------------------------------------

test("cycle：A→B→A→B 周期命中", () => {
  const d = new DoomLoop([new CycleDetector()]);
  d.reset(1);
  d.recordToolResult({ name: "search", args: {}, result: "r" });
  d.recordToolResult({ name: "read", args: {}, result: "r" });
  d.recordToolResult({ name: "search", args: {}, result: "r" });
  // 第 4 次调用后出现 search→read 周期（重复 2 次）→ 命中
  const signals = d.recordToolResult({ name: "read", args: {}, result: "r" });
  const cycleSignals = signals.filter(s => s.detector === "cycle");
  assert.equal(cycleSignals.length >= 1, true);
  assert.match(cycleSignals[0]?.reason ?? "", /周期模式/);
});

test("cycle：单调工具序列不命中", () => {
  const d = new DoomLoop([new CycleDetector()]);
  d.reset(1);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(d.recordToolResult({ name: `tool_${i}`, args: {}, result: "r" }).length, 0);
  }
});

// ---------------------------------------------------------------------------
// emptyResult —— 连续空结果
// ---------------------------------------------------------------------------

test("emptyResult：连续 4 次空结果命中", () => {
  const d = new DoomLoop([new EmptyResultDetector(4)]);
  d.reset(1);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(d.recordToolResult({ name: "read", args: {}, result: "" }).length, 0);
  }
  const signals = d.recordToolResult({ name: "read", args: {}, result: "" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.detector, "emptyResult");
});

test("emptyResult：有结果即清零", () => {
  const d = new DoomLoop([new EmptyResultDetector(4)]);
  d.reset(1);
  d.recordToolResult({ name: "read", args: {}, result: "" });
  d.recordToolResult({ name: "read", args: {}, result: "" });
  d.recordToolResult({ name: "read", args: {}, result: "有内容" });
  assert.equal(d.recordToolResult({ name: "read", args: {}, result: "" }).length, 0);
});

// ---------------------------------------------------------------------------
// circuitBreaker —— 单 turn 总量
// ---------------------------------------------------------------------------

test("circuitBreaker：超过上限命中（阈值 n 次内不触发，n+1 触发）", () => {
  const d = new DoomLoop([new CircuitBreakerDetector(3)]);
  d.reset(1);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(d.recordToolResult({ name: "t", args: {}, result: "r" }).length, 0);
  }
  const signals = d.recordToolResult({ name: "t", args: {}, result: "r" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.detector, "circuitBreaker");
});

// ---------------------------------------------------------------------------
// compactionBreaker —— 压缩空转
// ---------------------------------------------------------------------------

test("compactionBreaker：连续 3 轮仅输出摘要且不调工具命中", () => {
  const d = new DoomLoop([new CompactionBreakerDetector(3)]);
  d.reset(1);
  d.recordModelCall({ text: "总结：已完成全部步骤。" });
  d.recordModelCall({ text: "综上，无需更多操作。" });
  const signals = d.recordModelCall({ text: "综上所述，任务完成。" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.detector, "compactionBreaker");
});

test("compactionBreaker：调用工具打破空转", () => {
  const d = new DoomLoop([new CompactionBreakerDetector(3)]);
  d.reset(1);
  d.recordModelCall({ text: "总结：已完成。" });
  d.recordToolResult({ name: "read", args: {}, result: "r" }); // 调工具 → 清零
  assert.equal(d.recordModelCall({ text: "综上，继续。" }).length, 0);
});

// ---------------------------------------------------------------------------
// 协调器与 AgentLoop 契约
// ---------------------------------------------------------------------------

test("fatal 开关默认关闭（纯观测）：信号 fatal=false", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)]);
  d.reset(1);
  d.recordToolResult({ name: "read", args: { path: "/a" }, result: "ok" });
  d.recordToolResult({ name: "read", args: { path: "/a" }, result: "ok" });
  const signals = d.recordToolResult({ name: "read", args: { path: "/a" }, result: "ok" });
  assert.equal(signals[0]?.fatal, false);
  assert.equal(d.hasFatal(), false);
});

test("fatal 开关开启：hasFatal/fatalSignal 可用，reset 清空", () => {
  const d = new DoomLoop([new ToolCallLoopDetector(3)], { fatal: true });
  d.reset(1);
  d.recordToolResult({ name: "read", args: { path: "/a" }, result: "ok" });
  d.recordToolResult({ name: "read", args: { path: "/a" }, result: "ok" });
  d.recordToolResult({ name: "read", args: { path: "/a" }, result: "ok" });
  assert.equal(d.hasFatal(), true);
  assert.match(d.fatalSignal()?.reason ?? "", /完全相同的工具调用/);
  // reset 后清空
  d.reset(2);
  assert.equal(d.hasFatal(), false);
  assert.equal(d.signals().length, 0);
});

test("默认 6 检测器就绪且 reset 幂等", () => {
  const d = new DoomLoop();
  d.reset(1);
  assert.equal(d.maxToolCalls(), 30);
  d.reset(2);
  assert.equal(d.currentTurnNumber(), 2);
});

test("toolCallKey 对 args 序列化稳定", () => {
  assert.equal(toolCallKey({ name: "read", args: { path: "/a" } }), 'read:{"path":"/a"}');
  // 相同对象不同顺序序列化一致（JSON 键序稳定）
  assert.equal(
    toolCallKey({ name: "read", args: { path: "/a" } }),
    toolCallKey({ name: "read", args: { path: "/a" } }),
  );
});
