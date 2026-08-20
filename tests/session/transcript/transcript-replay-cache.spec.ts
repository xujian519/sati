import test from "node:test";
import assert from "node:assert/strict";
import type { CanonicalMessage } from "../../../src/model/index.js";
import {
  findLastCompactBoundaryIndex,
  replayTranscriptEntries,
} from "../../../src/session/transcript/TranscriptReplay.js";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";

/**
 * P2-B 投影缓存（TranscriptReplay.ts）：
 *  - 完全命中返回缓存 result 引用（0 次投影）；
 *  - 增量命中只投影新增 slice，结果与全量投影逐字节一致；
 *  - 新 boundary（遮蔽历史）/ 替换重写（同 length 不同 entryId）→ 全量重投影。
 * ⚠️ 契约固化：调用方不得修改返回的 result（数组/对象被缓存共享，修改即污染
 * 后续调用）。本文件所有用例只读消费返回值。
 */

const createdAt = "2026-08-14T00:00:00.000Z";

let seq = 0;
function nextSequence(): number {
  seq += 1;
  return seq;
}

// entryId 必须全局唯一（模拟真实 UUID）：硬编码会令不同测试的 entries 尾部
// entryId 相同 → 缓存误命中（替换重写场景尤其危险）。
let idCounter = 0;
function nextEntryId(): string {
  return `entry-${++idCounter}`;
}

function userInput(text: string, turnId: string): AgentTranscriptEntry {
  return {
    type: "accepted_input",
    sessionId: "s",
    turnId,
    sequence: nextSequence(),
    createdAt,
    entryId: nextEntryId(),
    messages: [{ role: "user", content: [{ type: "text", text }] }] as CanonicalMessage[],
  };
}

function assistantMessage(text: string, turnId: string): AgentTranscriptEntry {
  return {
    type: "assistant_message",
    sessionId: "s",
    turnId,
    sequence: nextSequence(),
    createdAt,
    entryId: nextEntryId(),
    message: { role: "assistant", content: [{ type: "text", text }] } as CanonicalMessage,
  };
}

function turnResult(turnId: string, withUsage?: { inputTokens?: number; outputTokens?: number }): AgentTranscriptEntry {
  return {
    type: "turn_result",
    sessionId: "s",
    turnId,
    sequence: nextSequence(),
    createdAt,
    entryId: nextEntryId(),
    result: {
      type: "success",
      sessionId: "s",
      turnId,
      stopReason: "completed",
      usage: withUsage ?? {},
      permissionDenials: [],
      turns: 1,
      startedAt: createdAt,
      completedAt: createdAt,
    },
  };
}

function compactBoundary(sequence: number): AgentTranscriptEntry {
  return {
    type: "control_boundary",
    sessionId: "s",
    turnId: "t-boundary",
    sequence,
    createdAt,
    entryId: `entry-boundary-${sequence}`,
    boundary: {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 10, postTokens: 5, messagesSummarized: 2, shadowedRanges: [] },
    },
  };
}

/** 与缓存无关的参照实现：总是全量投影。 */
function fullReplay(entries: AgentTranscriptEntry[]): ReturnType<typeof replayTranscriptEntries> {
  return replayTranscriptEntries(entries.map(entry => ({ ...entry, entryId: `ref-${entry.entryId}` })));
}

test("P2-B: 相同 entries 重复调用命中缓存（同一 result 引用）", () => {
  seq = 0;
  const entries = [userInput("你好", "t1"), assistantMessage("回复", "t1"), turnResult("t1")];
  const first = replayTranscriptEntries(entries);
  const second = replayTranscriptEntries(entries);
  assert.equal(second, first, "完全命中应返回同一 result 引用（零重投影）");
  assert.equal(second.messages, first.messages, "messages 数组应共享引用");
});

test("P2-B: 追加后增量投影与全量投影逐字段一致", () => {
  seq = 0;
  const base = [userInput("你好", "t1"), assistantMessage("回复", "t1"), turnResult("t1")];
  replayTranscriptEntries(base);

  // 追加第二条 turn
  const extended = [
    ...base,
    userInput("继续", "t2"),
    assistantMessage("继续回复", "t2"),
    turnResult("t2", { inputTokens: 10, outputTokens: 5 }),
  ];
  const incr = replayTranscriptEntries(extended);

  const full = fullReplay(extended);
  assert.deepEqual(incr.messages, full.messages, "消息投影一致");
  assert.deepEqual(incr.usage, full.usage, "usage 增量累积一致");
  assert.deepEqual(incr.diagnostics, full.diagnostics);
  assert.deepEqual(
    incr.events.map(e => e.type),
    full.events.map(e => e.type),
  );
  assert.deepEqual(incr.permissionDenials, full.permissionDenials);
  assert.equal(incr.lastCompactBoundaryIndex, full.lastCompactBoundaryIndex);
});

test("P2-B: 多次追加连续增量累积一致", () => {
  seq = 0;
  const entries: AgentTranscriptEntry[] = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    const turnId = `t${turn}`;
    entries.push(userInput(`输入${turn}`, turnId), assistantMessage(`回复${turn}`, turnId), turnResult(turnId));
    const incr = replayTranscriptEntries([...entries]);
    const full = fullReplay([...entries]);
    assert.deepEqual(incr.messages, full.messages, `第 ${turn} 轮增量应一致`);
    assert.deepEqual(incr.events, full.events);
    assert.equal(incr.usage.inputTokens, full.usage.inputTokens);
  }
});

test("P2-B: 新增 boundary 触发全量重投影（遮蔽历史消息）", () => {
  seq = 0;
  const base = [userInput("你好", "t1"), assistantMessage("回复", "t1"), turnResult("t1")];
  const first = replayTranscriptEntries(base);

  // 压缩：boundary + 压缩产物消息 + 新 turn
  const boundary = compactBoundary(nextSequence());
  const extended = [...base, boundary, userInput("新问题", "t2"), assistantMessage("新回复", "t2"), turnResult("t2")];
  const second = replayTranscriptEntries(extended);

  assert.notEqual(second, first, "boundary 出现应全量重投影（新 result 对象）");
  const boundaryIndex = findLastCompactBoundaryIndex(extended);
  assert.equal(second.lastCompactBoundaryIndex, boundaryIndex);
  assert.equal(second.lastCompactBoundary?.entryId, boundary.entryId);
  // boundary 之前的消息被遮蔽：messages 只含 boundary 之后
  assert.deepEqual(
    second.messages.map(m => (m.content[0]?.type === "text" ? m.content[0].text : "")),
    ["新问题", "新回复"],
    "boundary 前消息应被遮蔽",
  );
});

test("P2-B: 替换重写（同 length 不同 entryId）全量重投影", () => {
  seq = 0;
  const oldEntries = [userInput("旧", "t1"), assistantMessage("旧回复", "t1"), turnResult("t1")];
  replayTranscriptEntries(oldEntries);

  // 替换文件：同样 3 条但内容不同（entryId 不同 → 尾部衔接校验失败）
  const newEntries = [userInput("新", "t1"), assistantMessage("新回复", "t1"), turnResult("t1")];
  const result = replayTranscriptEntries(newEntries);
  assert.deepEqual(
    result.messages.map(m => (m.content[0]?.type === "text" ? m.content[0].text : "")),
    ["新", "新回复"],
    "替换后内容应来自新文件",
  );
});

test("P2-B: 增量补全 turn 时旧 warning 移除（与全量一致）", () => {
  seq = 0;
  const base = [userInput("你好", "t1"), assistantMessage("回复", "t1"), turnResult("t1")];
  replayTranscriptEntries(base);

  // 第一条 turn 的 durable 消息后无 turn_result（中断）→ warning
  const mid = [...base, userInput("继续", "t2"), assistantMessage("半截回复", "t2")];
  const midResult = replayTranscriptEntries(mid);
  assert.equal(
    midResult.messages.length,
    3,
    "turn 未完成时 durable 消息不投影（base 2 条 + t2 input 1 条，t2 assistant 被跳过）",
  );
  assert.equal(midResult.diagnostics.length, 1, "产生 incomplete turn warning");
  assert.match(midResult.diagnostics[0]!.message, /incomplete turn t2/);

  // 补全 turn_result → warning 移除、消息投影（与全量一致）
  const done = [...mid, turnResult("t2")];
  const doneResult = replayTranscriptEntries(done);
  assert.equal(doneResult.diagnostics.length, 0, "turn 补全后 warning 应移除");
  assert.deepEqual(
    doneResult.messages.map(m => (m.content[0]?.type === "text" ? m.content[0].text : "")),
    ["你好", "回复", "继续", "半截回复"],
    "补全后 durable 消息投影",
  );
  const full = fullReplay(done);
  assert.deepEqual(doneResult.diagnostics, full.diagnostics, "增量与全量诊断一致");
});

test("P2-B: 多会话交替调用（同 length 冲突）各自正确", () => {
  seq = 0;
  // 两个会话恰好同为 3 条（length 冲突）：缓存互踢但结果必须各自正确
  const sessionA = [userInput("A-问", "ta"), assistantMessage("A-答", "ta"), turnResult("ta")];
  const sessionB = [
    { ...userInput("B-问", "tb"), sessionId: "sb" },
    { ...assistantMessage("B-答", "tb"), sessionId: "sb" },
    { ...turnResult("tb"), sessionId: "sb" },
  ];
  const firstA = replayTranscriptEntries(sessionA);
  const firstB = replayTranscriptEntries(sessionB);
  const secondA = replayTranscriptEntries(sessionA);
  const secondB = replayTranscriptEntries(sessionB);

  assert.deepEqual(
    secondA.messages.map(m => (m.content[0]?.type === "text" ? m.content[0].text : "")),
    ["A-问", "A-答"],
    "A 会话内容正确（缓存被 B 互踢后重新投影）",
  );
  assert.deepEqual(
    secondB.messages.map(m => (m.content[0]?.type === "text" ? m.content[0].text : "")),
    ["B-问", "B-答"],
  );
  assert.deepEqual(secondA.messages, firstA.messages, "A 会话同内容投影稳定");
  assert.deepEqual(secondB.messages, firstB.messages, "B 会话同内容投影稳定");
});
