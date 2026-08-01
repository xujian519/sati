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

test("approval-keyword messages are persisted immediately and held in pending for approval", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const gate = new PatentOutputGate({ onPending: () => {} });
  const runner = new TurnRunner(
    makeLoop(["该方案存在侵权风险。", "专利结论：本方案具备新颖性。"]),
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

  // 两条消息都入库（风险词带免责声明，审批词也照常入库），顺序与产生顺序一致
  const persisted = durableMessages(transcript);
  assert.equal(persisted.length, 2);
  const firstEntry = persisted[0]!;
  if (firstEntry.type !== "durable_message") assert.fail("expected durable_message");
  assert.match(extractMessageText(firstEntry.message), /不构成正式法律意见/);
  assert.match(extractMessageText(persisted[1]!.message), /专利结论/);

  // 审批词消息同时挂起在审批队列
  assert.equal(gate.pendingCount(), 1);
  assert.equal(gate.pendingItems()[0]!.sessionId, "session-1");
  assert.equal(gate.pendingItems()[0]!.turnId, "turn-1");

  // 审批通过：仅完成流程控制，不再补写（消息已在库中）
  const pendingIndex = gate.pendingItems()[0]!.index;
  assert.equal(runner.approvePendingOutput(pendingIndex), true);
  assert.equal(gate.pendingCount(), 0);
  assert.equal(durableMessages(transcript).length, 2);
});

test("reject removes the pending entry but keeps the persisted message", async () => {
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
  // 消息本体已在挂起时入库，转录不丢失
  assert.equal(durableMessages(transcript).length, 1);
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
