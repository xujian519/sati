/**
 * 孤儿 turn 合成测试（阶段四 T4.3）。
 *
 * 覆盖：findOpenTurn 各种条目组合、buildInterruptedTurnResult 形状、
 * synthesizeInterruptedTurn 回调触发语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
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

test("synthesizeInterruptedTurn：开放时触发回调，否则不触发", () => {
  const openEntries: AgentTranscriptEntry[] = [entry({ type: "durable_message", turnId: "t3", message: {} as never })];
  let called = 0;
  synthesizeInterruptedTurn(
    openEntries,
    () => {
      called += 1;
    },
    "s1",
    "2026-08-16T01:00:00.000Z",
  );
  assert.equal(called, 1);
  const closedEntries: AgentTranscriptEntry[] = [
    entry({ type: "durable_message", turnId: "t3", message: {} as never }),
    entry({ type: "turn_result", turnId: "t3", result: {} as never }),
  ];
  synthesizeInterruptedTurn(
    closedEntries,
    () => {
      called += 1;
    },
    "s1",
    "2026-08-16T01:00:00.000Z",
  );
  assert.equal(called, 1);
});
