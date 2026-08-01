import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { PatentOutputGate } from "../../src/patent/output-gate.js";
import { extractMessageText } from "../../src/patent/output-gate.js";

const RESULT: AgentTurnResult = {
  type: "success",
  sessionId: "session-1",
  turnId: "turn-1",
  stopReason: "completed",
  usage: {},
  permissionDenials: [],
  turns: 1,
  startedAt: "2026-07-21T10:00:00.000Z",
  completedAt: "2026-07-21T10:00:01.000Z",
};

function makeLoop(messages: string[]): AgentLoop {
  const fakeLoop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      for (const text of messages) {
        await input.onDurableMessage?.({
          role: "assistant",
          content: [{ type: "text", text }],
        });
      }
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: RESULT };
      return { result: RESULT, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  return fakeLoop;
}

function durableMessages(transcript: InMemoryTranscriptWriter) {
  return transcript.entries.filter(entry => entry.type === "durable_message");
}

test("output gate holds approval-keyword messages out of persistence until approved", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const gate = new PatentOutputGate({ onPending: () => {} });
  const runner = new TurnRunner(
    makeLoop(["该方案不构成侵权。", "专利结论：本方案具备新颖性。"]),
    transcript,
    undefined,
    () => new Date("2026-07-21T10:00:01.000Z"),
    undefined,
    { cwd: "/workspace", transcriptPath: "" },
    undefined,
    gate,
  );

  for await (const _event of runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "分析新颖性" },
  })) {
    /* consume */
  }

  // 风险词消息：入库且注入免责声明
  const persisted = durableMessages(transcript);
  assert.equal(persisted.length, 1);
  const riskEntry = persisted[0]!;
  if (riskEntry.type !== "durable_message") assert.fail("expected durable_message");
  assert.match(extractMessageText(riskEntry.message), /不构成正式法律意见/);

  // 审批词消息：挂起不入库
  assert.equal(gate.pendingCount(), 1);

  // 审批通过 → 补写入库
  const pendingIndex = gate.pendingItems()[0]!.index;
  const approved = await runner.approvePendingOutput("session-1", "turn-1", pendingIndex);
  assert.equal(approved, true);
  assert.equal(gate.pendingCount(), 0);
  const afterApprove = durableMessages(transcript);
  assert.equal(afterApprove.length, 2);
});

test("output gate reject discards the held message permanently", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const gate = new PatentOutputGate({ onPending: () => {} });
  const runner = new TurnRunner(
    makeLoop(["专利结论：本方案具备新颖性。"]),
    transcript,
    undefined,
    () => new Date("2026-07-21T10:00:01.000Z"),
    undefined,
    { cwd: "/workspace", transcriptPath: "" },
    undefined,
    gate,
  );

  for await (const _event of runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "分析新颖性" },
  })) {
    /* consume */
  }

  assert.equal(gate.pendingCount(), 1);
  const pendingIndex = gate.pendingItems()[0]!.index;
  assert.equal(runner.rejectPendingOutput(pendingIndex), true);
  assert.equal(gate.pendingCount(), 0);
  assert.equal(durableMessages(transcript).length, 0);
});

test("without output gate all messages persist unchanged", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const runner = new TurnRunner(
    makeLoop(["专利结论：本方案具备新颖性。"]),
    transcript,
    undefined,
    () => new Date("2026-07-21T10:00:01.000Z"),
    undefined,
    { cwd: "/workspace", transcriptPath: "" },
  );

  for await (const _event of runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "分析新颖性" },
  })) {
    /* consume */
  }

  assert.equal(durableMessages(transcript).length, 1);
  const entry = durableMessages(transcript)[0]!;
  if (entry.type !== "durable_message") assert.fail("expected durable_message");
  assert.equal(extractMessageText(entry.message), "专利结论：本方案具备新颖性。");
});
