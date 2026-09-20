import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";

const createdAt = "2026-08-02T00:00:00.000Z";

function messageText(entry: { content: Array<{ type: string; text?: string }> }): string {
  return entry.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

function turnResult(turnId: string, sequence: number): AgentTranscriptEntry {
  return {
    type: "turn_result",
    sessionId: "session-compact",
    turnId,
    sequence,
    createdAt,
    result: {
      type: "success",
      sessionId: "session-compact",
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

function oldHistoryEntries(): AgentTranscriptEntry[] {
  return [
    {
      type: "accepted_input",
      sessionId: "session-compact",
      turnId: "turn-old",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "old accepted input" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "session-compact",
      turnId: "turn-old",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "old assistant reply" }] },
    },
    turnResult("turn-old", 3),
  ];
}

test("transcript replay resumes from the compact snapshot baked into the boundary record", () => {
  const entries: AgentTranscriptEntry[] = [
    ...oldHistoryEntries(),
    {
      type: "control_boundary",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 4,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preTokens: 120,
          postTokens: 40,
          messagesSummarized: 2,
        },
        // 整份替换上下文与边界同一条记录：即便该 turn 没有 turn_result 也算完整。
        snapshot: {
          version: 1,
          messages: [
            {
              role: "assistant",
              metadata: { compactReplacement: true },
              content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\nsummary" }],
            },
            {
              role: "user",
              metadata: { compactReplacement: true },
              content: [{ type: "text", text: "kept tail input" }],
            },
          ],
        },
      },
    },
  ];

  const replay = replayTranscriptEntries(entries);
  const replayText = replay.messages.map(messageText).join("\n");

  assert.equal(replay.lastCompactBoundaryIndex, 3);
  assert.equal(replay.lastCompactBoundary?.type, "control_boundary");
  assert.doesNotMatch(replayText, /old accepted input/);
  assert.doesNotMatch(replayText, /old assistant reply/);
  assert.match(replayText, /\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
  assert.match(replayText, /kept tail input/);
  assert.equal(
    replay.messages.every(message => message.metadata?.compactReplacement === true),
    true,
  );
});

test("legacy boundary (boundary + per-message replacements) keeps the legacy path: drops prior history", () => {
  const entries: AgentTranscriptEntry[] = [
    ...oldHistoryEntries(),
    {
      type: "control_boundary",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 4,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preTokens: 120,
          postTokens: 40,
          messagesSummarized: 2,
        },
      },
    },
    {
      type: "assistant_message",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 5,
      createdAt,
      message: {
        role: "assistant",
        metadata: { compactReplacement: true },
        content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\nsummary" }],
      },
    },
    {
      type: "durable_message",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 6,
      createdAt,
      message: {
        role: "user",
        metadata: { compactReplacement: true },
        content: [{ type: "text", text: "kept tail input" }],
      },
    },
    turnResult("turn-compact", 7),
  ];

  const replay = replayTranscriptEntries(entries);
  const replayText = replay.messages.map(messageText).join("\n");

  assert.equal(replay.lastCompactBoundaryIndex, 3, "legacy 边界沿用旧语义授权丢弃历史");
  assert.equal(replay.lastCompactBoundary?.type, "control_boundary");
  assert.doesNotMatch(replayText, /old accepted input/);
  assert.doesNotMatch(replayText, /old assistant reply/);
  assert.match(replayText, /\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
  assert.match(replayText, /kept tail input/);
  assert.equal(
    replay.diagnostics.some(diagnostic => diagnostic.code === "transcript_entry_invalid"),
    false,
    "legacy 边界是完整记录（只是没有快照字段），不得报损坏告警",
  );
});

test("boundary declaring an unreadable snapshot is not waved through as legacy", () => {
  // 磁盘上的旧版本记录：类型系统里不存在 version 2，故意构造异构形状验证放行口径。
  const corruptedBoundary = {
    type: "control_boundary",
    sessionId: "session-compact",
    turnId: "turn-compact",
    sequence: 4,
    createdAt,
    boundary: {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        trigger: "auto",
        preTokens: 120,
        postTokens: 40,
        messagesSummarized: 2,
      },
      // 声明了快照却读不出来（版本不符）：既不能证明替换内容完整，也不能当作
      // 「从没有过快照」按 legacy 放行。
      snapshot: { version: 2, messages: [] },
    },
  } as unknown as AgentTranscriptEntry;

  const entries: AgentTranscriptEntry[] = [
    ...oldHistoryEntries(),
    corruptedBoundary,
    {
      type: "durable_message",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 5,
      createdAt,
      message: {
        role: "user",
        metadata: { compactReplacement: true },
        content: [{ type: "text", text: "partial replacement tail" }],
      },
    },
    turnResult("turn-compact", 6),
  ];

  const replay = replayTranscriptEntries(entries);
  const replayText = replay.messages.map(messageText).join("\n");

  assert.match(replayText, /old accepted input/, "损坏记录不授权丢弃历史");
  assert.match(replayText, /old assistant reply/);
  assert.equal(replay.lastCompactBoundaryIndex, undefined);
  assert.equal(
    replay.diagnostics.some(
      diagnostic => diagnostic.code === "transcript_entry_invalid" && /unreadable snapshot/.test(diagnostic.message),
    ),
    true,
    "损坏记录须留下告警",
  );
  // 未授权边界时其后消息按普通条目进入上下文：损坏记录不遮蔽，也不吞掉散落的替换消息
  // （原文 + 一份冗余摘要，安全侧冗余；见决策记录 Consequences）。
  assert.match(replayText, /partial replacement tail/);
});
