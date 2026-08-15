/**
 * 孤儿 turn 合成测试（阶段四 T4.3）。
 *
 * 覆盖：findOpenTurn 各种条目组合、buildInterruptedTurnResult 形状、
 * synthesizeInterruptedTurn 回调触发语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import {
  buildInterruptedTurnResult,
  findOpenTurn,
  synthesizeInterruptedTurn,
} from "../../src/session/transcript/interruptedTurn.js";

function entry(
  overrides: Partial<AgentTranscriptEntry> & { type: AgentTranscriptEntry["type"]; turnId: string },
): AgentTranscriptEntry {
  return {
    sessionId: "s1",
    sequence: 0,
    createdAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  } as AgentTranscriptEntry;
}

test("findOpenTurn：无活动返回 undefined", () => {
  assert.equal(findOpenTurn([]), undefined);
});

test("findOpenTurn：全部 turn 已收尾返回 undefined", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "accepted_input", turnId: "t1", messages: [] }),
    entry({ type: "turn_result", turnId: "t1", result: {} as never }),
  ];
  assert.equal(findOpenTurn(entries), undefined);
});

test("findOpenTurn：最后一个 turn 未收尾即开放，并返回起始时间", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "accepted_input", turnId: "t1", messages: [] }),
    entry({ type: "turn_result", turnId: "t1", result: {} as never }),
    entry({ type: "request_header", turnId: "t2", header: {} as never, createdAt: "2026-08-16T01:00:00.000Z" }),
  ];
  const open = findOpenTurn(entries);
  assert.deepEqual(open, { turnId: "t2", startedAt: "2026-08-16T01:00:00.000Z" });
});

test("buildInterruptedTurnResult：interrupted 收尾形状", () => {
  const result = buildInterruptedTurnResult(
    "s1",
    "t2",
    "2026-08-16T01:00:00.000Z",
    () => new Date("2026-08-16T02:00:00.000Z"),
  );
  assert.equal(result.type, "error");
  assert.equal(result.stopReason, "interrupted");
  assert.equal(result.errors?.[0]?.code, "agent_turn_interrupted");
  assert.equal(result.startedAt, "2026-08-16T01:00:00.000Z");
  assert.equal(result.completedAt, "2026-08-16T02:00:00.000Z");
});

test("synthesizeInterruptedTurn：开放时触发回调并返回合成条目，否则 undefined", () => {
  const openEntries: AgentTranscriptEntry[] = [entry({ type: "durable_message", turnId: "t3", message: {} as never })];
  let called = 0;
  const synthesized = synthesizeInterruptedTurn(
    openEntries,
    () => {
      called += 1;
    },
    "s1",
    {
      nextSequence: 5,
      parentEntryId: null,
      now: () => new Date("2026-08-16T02:00:00.000Z"),
    },
  );
  assert.equal(called, 1);
  assert.ok(synthesized !== undefined);
  assert.equal(synthesized.type, "turn_result");
  assert.equal(synthesized.turnId, "t3");
  assert.equal(synthesized.sequence, 5);
  assert.equal(synthesized.createdAt, "2026-08-16T02:00:00.000Z");
  assert.equal(synthesized.result.stopReason, "interrupted");
  assert.equal(synthesized.result.errors?.[0]?.code, "agent_turn_interrupted");

  const closedEntries: AgentTranscriptEntry[] = [
    entry({ type: "durable_message", turnId: "t3", message: {} as never }),
    entry({ type: "turn_result", turnId: "t3", result: {} as never }),
  ];
  const none = synthesizeInterruptedTurn(
    closedEntries,
    () => {
      called += 1;
    },
    "s1",
    { nextSequence: 6 },
  );
  assert.equal(called, 1);
  assert.equal(none, undefined);
});

test("合成条目并入条目序列后，重放立即闭合开放 turn（不再报 incomplete turn）", () => {
  const durable: AgentTranscriptEntry = entry({
    type: "durable_message",
    turnId: "t1",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
  const entries: AgentTranscriptEntry[] = [entry({ type: "accepted_input", turnId: "t1", messages: [] }), durable];

  // 合成前：开放 turn 的 durable 消息被丢弃并报诊断。
  const before = replayTranscriptEntries(entries);
  assert.ok(before.diagnostics.some(d => d.code === "transcript_entry_invalid"));
  assert.equal(before.messages.length, 0);

  // 合成 + 并入序列后：turn 闭合，消息投影、turn_completed 事件出现。
  const synthesized = synthesizeInterruptedTurn(entries, () => {}, "s1", { nextSequence: 3 });
  assert.ok(synthesized !== undefined);
  entries.push(synthesized);
  const after = replayTranscriptEntries(entries);
  assert.equal(
    after.diagnostics.some(d => d.code === "transcript_entry_invalid"),
    false,
  );
  assert.ok(after.messages.some(m => m.content.some(b => b.type === "text" && b.text === "hi")));
  assert.ok(after.events.some(e => e.type === "turn_completed" && e.turnId === "t1"));
});
