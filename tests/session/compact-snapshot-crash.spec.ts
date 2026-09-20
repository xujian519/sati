import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import type { CompactSnapshotPayload } from "../../src/session/transcript/CompactSnapshot.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";

/**
 * 压缩落盘的崩溃安全（上游 #599 引入）。
 *
 * 缺陷形态：压缩原本写「边界记录 + N 条替换消息」两条时序记录，两者之间存在
 * 崩溃窗口。边界已落盘而替换消息未落盘（或只落了前半）时，重放仅凭边界存在
 * 就丢弃边界前历史 ⇒ 模型上下文凭空缩水；若替换消息所属 turn 还缺 turn_result，
 * 这些替换消息本身也会被跳过 ⇒ 上下文几乎清空。
 *
 * 契约（双轨口径）：**快照形态**只有「带完整且可校验快照」的边界才授权丢弃边界前
 * 历史；快照声明存在却不可读时保留原文历史并给出 warning。**legacy 形态**（磁盘上
 * 没有 snapshot 字段）沿用旧语义：边界授权丢弃历史、替换内容由紧随的替换消息提供
 * ——既有会话的重放结果因此不变（代价见 `docs/notes/implemented/2026-09-20-compact-snapshot-crash-safety.md`）。
 */

const createdAt = "2026-09-20T00:00:00.000Z";
const SESSION = "session-compact-crash";
const TURN_OLD = "turn-old";
const TURN_COMPACT = "turn-compact";

function replayText(entries: AgentTranscriptEntry[]): string {
  return replayTranscriptEntries(entries)
    .messages.map(message =>
      message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map(block => block.text)
        .join("\n"),
    )
    .join("\n");
}

function userMessage(text: string, compactReplacement = false): CanonicalMessage {
  return {
    role: "user",
    ...(compactReplacement ? { metadata: { compactReplacement: true } } : {}),
    content: [{ type: "text", text }],
  };
}

function assistantMessage(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function acceptedInput(turnId: string, sequence: number, text: string): AgentTranscriptEntry {
  return {
    type: "accepted_input",
    sessionId: SESSION,
    turnId,
    sequence,
    createdAt,
    messages: [userMessage(text)],
  };
}

function assistantEntry(turnId: string, sequence: number, text: string): AgentTranscriptEntry {
  return {
    type: "assistant_message",
    sessionId: SESSION,
    turnId,
    sequence,
    createdAt,
    message: assistantMessage(text),
  };
}

function durableEntry(turnId: string, sequence: number, message: CanonicalMessage): AgentTranscriptEntry {
  return { type: "durable_message", sessionId: SESSION, turnId, sequence, createdAt, message };
}

function turnResult(turnId: string, sequence: number): AgentTranscriptEntry {
  return {
    type: "turn_result",
    sessionId: SESSION,
    turnId,
    sequence,
    createdAt,
    result: {
      type: "success",
      sessionId: SESSION,
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

function compactBoundary(sequence: number, snapshot?: CompactSnapshotPayload): AgentTranscriptEntry {
  return {
    type: "control_boundary",
    sessionId: SESSION,
    turnId: TURN_COMPACT,
    sequence,
    createdAt,
    boundary: {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 30, messagesSummarized: 2 },
      ...(snapshot !== undefined ? { snapshot } : {}),
    },
  };
}

/** 压缩前的原始历史（崩溃后必须能够原样恢复）。 */
function historyEntries(): AgentTranscriptEntry[] {
  return [
    acceptedInput(TURN_OLD, 1, "old accepted input"),
    assistantEntry(TURN_OLD, 2, "old assistant reply"),
    turnResult(TURN_OLD, 3),
  ];
}

function hasInvalidBoundaryDiagnostic(entries: AgentTranscriptEntry[]): boolean {
  return replayTranscriptEntries(entries).diagnostics.some(
    diagnostic => diagnostic.code === "transcript_entry_invalid" && /compact/i.test(diagnostic.message),
  );
}

test("legacy 形态（边界无 snapshot 字段）沿用旧语义：边界授权丢弃历史", () => {
  const entries = [...historyEntries(), compactBoundary(4)];

  const replay = replayTranscriptEntries(entries);

  assert.equal(replay.lastCompactBoundaryIndex, 3, "legacy 边界仍授权丢弃边界前历史");
  assert.equal(replay.lastCompactBoundary?.type, "control_boundary");
  assert.deepEqual(replay.messages, [], "替换消息未落盘时上下文为空——这是 legacy 形态的既有窗口");
  assert.equal(hasInvalidBoundaryDiagnostic(entries), false, "legacy 形态是完整记录，不得被当作损坏记录告警");
});

test("legacy 替换记录（无快照，turn 已完成）按旧语义重放为模型可见消息", () => {
  const entries = [
    ...historyEntries(),
    compactBoundary(4),
    durableEntry(TURN_COMPACT, 5, userMessage("partial replacement tail", true)),
    turnResult(TURN_COMPACT, 6),
  ];

  const text = replayText(entries);

  assert.doesNotMatch(text, /old accepted input/);
  assert.match(text, /partial replacement tail/);
});

test("有效快照在 turn 未完成时即生效，不依赖 turn_result", () => {
  const entries = [
    ...historyEntries(),
    compactBoundary(4, {
      version: 1,
      messages: [userMessage("[compacted] summary"), assistantMessage("[compacted] reply")],
    }),
  ];

  const text = replayText(entries);

  assert.match(text, /\[compacted\] summary/);
  assert.match(text, /\[compacted\] reply/);
  assert.doesNotMatch(text, /old accepted input/);
});

test("快照校验不通过（空消息集）时不授权丢弃历史", () => {
  const entries = [...historyEntries(), compactBoundary(4, { version: 1, messages: [] })];

  const text = replayText(entries);

  assert.match(text, /old accepted input/);
  assert.equal(hasInvalidBoundaryDiagnostic(entries), true);
});
