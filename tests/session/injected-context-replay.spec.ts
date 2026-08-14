import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { readInjectedContexts, replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";

/**
 * 注入内容落库（「模型可见 = 已记录」）：
 *  - injected_context 条目不进入重放投影（模型可见 messages 不受注入影响）；
 *  - readInjectedContexts 按顺序读取，支持 turnId/source 过滤（审计面）。
 */

const createdAt = "2026-08-14T00:00:00.000Z";

function completedTurn(turnId: string, sequence: number): AgentTranscriptEntry {
  return {
    type: "turn_result",
    sessionId: "s",
    turnId,
    sequence,
    createdAt,
    result: {
      type: "success",
      sessionId: "s",
      turnId,
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: createdAt,
      completedAt: createdAt,
    },
  };
}

function makeTranscript(): AgentTranscriptEntry[] {
  return [
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t1",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "用户的真实输入" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "模型回复" }] },
    },
    completedTurn("t1", 3),
    {
      type: "injected_context",
      sessionId: "s",
      turnId: "t1",
      sequence: 4,
      createdAt,
      source: "memory",
      text: "<memory-context> 记忆检索段落 </memory-context>",
    },
    {
      type: "injected_context",
      sessionId: "s",
      turnId: "t1",
      sequence: 5,
      createdAt,
      source: "project_instructions",
      text: "<project-instructions> SATI.md 内容 </project-instructions>",
    },
  ];
}

test("replayTranscriptEntries 投影跳过 injected_context（不进入模型可见 messages）", () => {
  const replay = replayTranscriptEntries(makeTranscript());
  const texts = replay.messages.map(m => (m.content[0]?.type === "text" ? m.content[0].text : ""));
  assert.deepEqual(texts, ["用户的真实输入", "模型回复"]);
  assert.equal(replay.messages.length, 2);
});

test("readInjectedContexts 按 transcript 顺序返回全部注入条目", () => {
  const records = readInjectedContexts(makeTranscript());
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map(r => r.source),
    ["memory", "project_instructions"],
  );
  assert.equal(records[0]!.text, "<memory-context> 记忆检索段落 </memory-context>");
  assert.equal(records[1]!.turnId, "t1");
});

test("readInjectedContexts 支持 turnId / source 过滤", () => {
  const entries = makeTranscript();
  assert.equal(readInjectedContexts(entries, { source: "memory" }).length, 1);
  assert.equal(readInjectedContexts(entries, { source: "methodology" }).length, 0);
  assert.equal(readInjectedContexts(entries, { turnId: "t-other" }).length, 0);
  assert.equal(readInjectedContexts(entries, { turnId: "t1", source: "project_instructions" }).length, 1);
});

test("InMemoryTranscriptWriter 写入 injected_context 条目", async () => {
  const { InMemoryTranscriptWriter } = await import("../../src/session/transcript/InMemoryTranscriptWriter.js");
  const writer = new InMemoryTranscriptWriter();
  writer.recordInjectedContext("s", "t1", { source: "memory", text: "注入段落" });
  assert.equal(writer.entries.length, 1);
  assert.equal(writer.entries[0]!.type, "injected_context");
  const entry = writer.entries[0] as Extract<(typeof writer.entries)[number], { type: "injected_context" }>;
  assert.equal(entry.source, "memory");
  assert.equal(entry.text, "注入段落");
});
