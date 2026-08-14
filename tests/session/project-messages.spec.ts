import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { projectMessagesFromTranscript } from "../../src/session/transcript/TranscriptReplay.js";
import { AgentSession } from "../../src/agent/session/AgentSession.js";
import type { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";

/**
 * 运行期 messages 投影化（阶段二剩余项）：
 *  - projectMessagesFromTranscript：transcript（唯一真源）→ 模型可见历史消息
 *    （最后一次压缩边界之后的压缩产物 + 新增 durable 消息）；
 *  - AgentSession.submit：注入投影器后历史输入从 transcript 派生（持久层为
 *    准）；未注入时回退 state.messages（内存 transcript / 测试场景）。
 */

const createdAt = "2026-08-14T00:00:00.000Z";

function turnResult(turnId: string, sequence: number): AgentTranscriptEntry {
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

test("projectMessagesFromTranscript：压缩边界后切片（压缩产物 + 新增）", () => {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t1",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "旧消息" }] }],
    },
    turnResult("t1", 2),
    {
      type: "control_boundary",
      sessionId: "s",
      turnId: "t1",
      sequence: 3,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 10 },
      },
    },
    {
      type: "durable_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 4,
      createdAt,
      message: { role: "user", content: [{ type: "text", text: "压缩摘要产物" }] },
    },
    {
      type: "durable_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 5,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "压缩后新增回复" }] },
    },
  ];
  const projected = projectMessagesFromTranscript(entries);
  const texts = projected.map(m => (m.content[0]!.type === "text" ? m.content[0].text : ""));
  assert.deepEqual(texts, ["压缩摘要产物", "压缩后新增回复"]);
});

test("projectMessagesFromTranscript：无压缩边界时返回全部完成 turn 的可见消息", () => {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t1",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "输入一" }] }],
    },
    {
      type: "durable_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "回复一" }] },
    },
    turnResult("t1", 3),
  ];
  const projected = projectMessagesFromTranscript(entries);
  assert.equal(projected.length, 2);
});

function fakeTurnRunner(onRunMessages: (messages: unknown[]) => void): TurnRunner {
  return {
    run: async function* (options: { messages: unknown[] }) {
      onRunMessages(options.messages);
      yield { type: "turn_started", sessionId: "s", turnId: "t1" };
      const result: AgentTurnResult = {
        type: "success",
        sessionId: "s",
        turnId: "t1",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      };
      yield { type: "turn_completed", sessionId: "s", turnId: "t1", result };
      return { result, messages: [] as never[] };
    },
    approvePendingOutput: () => true,
    rejectPendingOutput: () => true,
    snapshotForRuntimeReload: () => ({
      runtimeContext: { cwd: "/tmp", transcriptPath: "" },
      transcriptWriterState: { sequence: 0, lastEntryId: null },
      fileState: {},
    }),
    snapshotFileState: () => ({}),
  } as unknown as TurnRunner;
}

test("AgentSession.submit：注入投影器后历史输入从 transcript 派生", async () => {
  let captured: unknown[] | undefined;
  const turnRunner = fakeTurnRunner(m => {
    captured = m;
  });
  const session = new AgentSession({
    sessionId: "s",
    turnRunner,
    initialState: {
      sessionId: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "内存累积消息" }] }],
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    },
    projectMessages: async () => [{ role: "assistant", content: [{ type: "text", text: "transcript 投影消息" }] }],
  });
  for await (const _event of session.submit({ type: "text", text: "hi" })) {
    // 消费事件流
  }
  assert.ok(captured, "turnRunner.run 应被调用");
  assert.equal((captured![0] as { content: { text: string }[] }).content[0]!.text, "transcript 投影消息");
});

test("AgentSession.submit：未注入投影器时回退 state.messages（内存 transcript）", async () => {
  let captured: unknown[] | undefined;
  const turnRunner = fakeTurnRunner(m => {
    captured = m;
  });
  const session = new AgentSession({
    sessionId: "s",
    turnRunner,
    initialState: {
      sessionId: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "内存回退消息" }] }],
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    },
  });
  for await (const _event of session.submit({ type: "text", text: "hi" })) {
    // 消费事件流
  }
  assert.ok(captured, "turnRunner.run 应被调用");
  assert.equal((captured![0] as { content: { text: string }[] }).content[0]!.text, "内存回退消息");
});
