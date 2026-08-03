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

  // 审批通过：仅完成流程控制，不再补写（消息已在库中）；sessionId 绑定会话（D4 fail-closed 守卫）
  const pendingIndex = gate.pendingItems()[0]!.index;
  assert.equal(runner.approvePendingOutput(pendingIndex, "session-1"), true);
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
  assert.equal(runner.rejectPendingOutput(pendingIndex, "session-1"), true);
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

test("D1: onPending fires only after the durable message is written", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const order: string[] = [];
  const gate = new PatentOutputGate({
    onPending: () => {
      order.push("onPending");
    },
  });
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

  // 消息先入库，后触发 onPending（挂起条目保证消息已在转录中）
  assert.equal(durableMessages(transcript).length, 1);
  assert.equal(gate.pendingCount(), 1);
  assert.deepEqual(order, ["onPending"]);
});

test("D1: transcript write failure cancels the pending entry and rethrows", async () => {
  const failingTranscript = new InMemoryTranscriptWriter();
  failingTranscript.recordDurableMessage = () => {
    throw new Error("disk full");
  };

  let pendingFired = 0;
  const gate = new PatentOutputGate({
    onPending: () => {
      pendingFired += 1;
    },
  });
  const runner = new TurnRunner(
    makeLoop(["专利结论：本方案具备新颖性。"]),
    failingTranscript,
    undefined,
    () => new Date("2026-07-21T10:00:01.000Z"),
    undefined,
    { cwd: "/workspace", transcriptPath: "" },
    undefined,
    gate,
  );

  let failed = false;
  for await (const event of runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "分析新颖性" },
  })) {
    if (event.type === "turn_failed") failed = true;
  }

  assert.equal(failed, true, "transcript failure must surface as turn_failed");
  assert.equal(gate.pendingCount(), 0, "failed write must not leave a dangling pending entry");
  assert.equal(pendingFired, 0, "onPending must never fire for a message that was not written");
});

test("D5: compaction replays pass through the gate without re-hanging approval", async () => {
  const transcript = new InMemoryTranscriptWriter();
  let pendingFired = 0;
  const gate = new PatentOutputGate({
    onPending: () => {
      pendingFired += 1;
    },
  });
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      // 模拟压缩重放：摘要消息含风险词与审批词
      await input.onCompactPersisted?.({
        boundary: {
          kind: "compact",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "auto", preTokens: 100 },
        },
        messages: [
          { role: "assistant", content: [{ type: "text", text: "该方案存在侵权风险，专利结论：具备新颖性。" }] },
        ],
      });
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: RESULT };
      return { result: RESULT, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
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
    input: { type: "text", text: "分析" },
  })) {
    /* consume */
  }

  // 摘要入库且经过门禁（风险词 → 免责声明追加）
  const persisted = durableMessages(transcript);
  assert.equal(persisted.length, 1);
  const entry = persisted[0]!;
  if (entry.type !== "durable_message") assert.fail("expected durable_message");
  assert.match(extractMessageText(entry.message), /不构成正式法律意见/);
  // skipApproval：重放内容不重复挂起、不触发 onPending
  assert.equal(gate.pendingCount(), 0, "replayed content must not re-hang");
  assert.equal(pendingFired, 0);
});

test("D5: re-processing an already-gated message does not duplicate hints", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const gate = new PatentOutputGate({ onPending: () => {} });
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      // 首次入库（走 onDurableMessage），随后压缩重放同一消息（走 onCompactPersisted）
      await input.onDurableMessage?.({
        role: "assistant",
        content: [{ type: "text", text: "该方案绝对可靠且存在侵权风险。" }],
      });
      await input.onCompactPersisted?.({
        boundary: {
          kind: "compact",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "auto", preTokens: 100 },
        },
        messages: [{ role: "assistant", content: [{ type: "text", text: "该方案绝对可靠且存在侵权风险。" }] }],
      });
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: RESULT };
      return { result: RESULT, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
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
    input: { type: "text", text: "分析" },
  })) {
    /* consume */
  }

  const persisted = durableMessages(transcript);
  assert.equal(persisted.length, 2);
  const first = extractMessageText(persisted[0]!.message);
  const second = extractMessageText(persisted[1]!.message);
  // 免责声明与绝对化提示在首次处理后的文本中只出现一次，重放不重复追加
  assert.equal((first.match(/不构成正式法律意见/g) ?? []).length, 1);
  assert.equal((first.match(/绝对化表述/g) ?? []).length, 1);
  assert.equal(second, first, "replay of an already-gated message must be byte-identical");
});
