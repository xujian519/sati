import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import {
  replayShadowedMessages,
  replayShadowedMessagesAt,
  replayTranscriptEntries,
} from "../../src/session/transcript/TranscriptReplay.js";
import { compressIndexRanges } from "../../src/context/compaction/CompactionEngine.js";

/**
 * 遮蔽范围可恢复化测试（S2-A，对应 dsh surface replace 语义）。
 *
 * 压缩不删历史——transcript 原文完整保留，compact_boundary 记录
 * shadowedRanges（被遮蔽消息的索引范围），replayShadowedMessages 据此
 * 恢复被摘要替代的完整原文。
 */

const createdAt = "2026-08-02T00:00:00.000Z";

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

function messageText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

/** 3 轮旧消息（索引 0-3）+ 压缩边界（遮蔽 [0,1]）+ 压缩后消息。 */
function makeCompactedTranscript(
  shadowedRanges?: Array<{ fromIndex: number; toIndex: number }>,
): AgentTranscriptEntry[] {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t1",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "msg-0 用户输入" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "msg-1 助手回复" }] },
    },
    turnResult("t1", 3),
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t2",
      sequence: 4,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "msg-2 保留头部" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t2",
      sequence: 5,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "msg-3 保留回复" }] },
    },
    turnResult("t2", 6),
    {
      type: "control_boundary",
      sessionId: "s",
      turnId: "t3",
      sequence: 7,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preTokens: 120,
          postTokens: 40,
          messagesSummarized: 2,
          ...(shadowedRanges !== undefined ? { shadowedRanges } : {}),
        },
      },
    },
    {
      type: "durable_message",
      sessionId: "s",
      turnId: "t3",
      sequence: 8,
      createdAt,
      message: {
        role: "user",
        metadata: { compactReplacement: true },
        content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\n摘要" }],
      },
    },
    turnResult("t3", 9),
  ];
  return entries;
}

test("compressIndexRanges：连续索引合并为含端范围", () => {
  assert.deepEqual(compressIndexRanges([]), []);
  assert.deepEqual(compressIndexRanges([0, 1, 2]), [{ fromIndex: 0, toIndex: 2 }]);
  assert.deepEqual(compressIndexRanges([0, 1, 2, 5, 6]), [
    { fromIndex: 0, toIndex: 2 },
    { fromIndex: 5, toIndex: 6 },
  ]);
  assert.deepEqual(compressIndexRanges([7]), [{ fromIndex: 7, toIndex: 7 }]);
});

test("replayShadowedMessages：按 shadowedRanges 恢复被遮蔽原文", () => {
  const entries = makeCompactedTranscript([{ fromIndex: 0, toIndex: 1 }]);
  const restored = replayShadowedMessages(entries);
  assert.equal(restored.messages.length, 2);
  assert.equal(messageText(restored.messages[0]!), "msg-0 用户输入");
  assert.equal(messageText(restored.messages[1]!), "msg-1 助手回复");
  assert.deepEqual(restored.matchedIndexes, [0, 1]);
});

test("replayShadowedMessages：多个范围恢复全部遮蔽段", () => {
  // 遮蔽 msg-0 与 msg-2（非连续），保留 msg-1 / msg-3。
  const entries = makeCompactedTranscript([
    { fromIndex: 0, toIndex: 0 },
    { fromIndex: 2, toIndex: 2 },
  ]);
  const restored = replayShadowedMessages(entries);
  assert.equal(restored.messages.length, 2);
  assert.equal(messageText(restored.messages[0]!), "msg-0 用户输入");
  assert.equal(messageText(restored.messages[1]!), "msg-2 保留头部");
});

test("replayShadowedMessages：无 shadowedRanges 返回空（模型视图不受影响）", () => {
  const entries = makeCompactedTranscript();
  const restored = replayShadowedMessages(entries);
  assert.equal(restored.messages.length, 0);
  assert.deepEqual(restored.matchedIndexes, []);
});

test("replayShadowedMessages：无压缩边界返回空", () => {
  const entries = makeCompactedTranscript([{ fromIndex: 0, toIndex: 1 }]).filter(
    entry => entry.type !== "control_boundary",
  );
  const restored = replayShadowedMessages(entries);
  assert.equal(restored.messages.length, 0);
});

test("恢复不改变模型视图（replayTranscriptEntries 行为不变）", () => {
  const entries = makeCompactedTranscript([{ fromIndex: 0, toIndex: 1 }]);
  const replay = replayTranscriptEntries(entries);
  const replayText = replay.messages.map(messageText).join("\n");
  assert.doesNotMatch(replayText, /msg-0/);
  assert.doesNotMatch(replayText, /msg-1/);
  assert.match(replayText, /摘要/);
});

test("replayShadowedMessages：范围越界时截断到投影序列末尾并产出对齐诊断", () => {
  const entries = makeCompactedTranscript([{ fromIndex: 0, toIndex: 99 }]);
  const restored = replayShadowedMessages(entries);
  // 投影序列 = 最后一次压缩输入区间（boundary 之前的 4 条旧消息），越界部分被截断。
  assert.equal(restored.messages.length, 4);
  assert.equal(restored.diagnostics.length, 1, "越界截断触发对齐自检诊断");
  assert.equal(restored.diagnostics[0]!.code, "shadowed_message_alignment");
});

/** 两次压缩：C1 遮蔽 [A,B]，C2 输入 = C1 产物 + 新消息，遮蔽 [0,3]。 */
function makeMultiCompactedTranscript(): AgentTranscriptEntry[] {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t1",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "msg-A 输入" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "msg-B 回复" }] },
    },
    turnResult("t1", 3),
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t2",
      sequence: 4,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "msg-C 输入" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t2",
      sequence: 5,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "msg-D 回复" }] },
    },
    turnResult("t2", 6),
    // C1 边界：遮蔽 [A, B]（索引 0-1）。
    {
      type: "control_boundary",
      sessionId: "s",
      turnId: "t3",
      sequence: 7,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preTokens: 120,
          postTokens: 40,
          messagesSummarized: 2,
          shadowedRanges: [{ fromIndex: 0, toIndex: 1 }],
        },
      },
    },
    // C1 产物落库（b1 摘要 + s1 保留 + C'/D' 原文重放）。
    ...["msg-b1 摘要", "msg-s1 保留", "msg-C' 重放", "msg-D' 重放"].map((text, i) => ({
      type: "durable_message" as const,
      sessionId: "s",
      turnId: "t3",
      sequence: 8 + i,
      createdAt,
      message: {
        role: "user" as const,
        metadata: { compactReplacement: true },
        content: [{ type: "text" as const, text }],
      },
    })),
    turnResult("t3", 12),
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t4",
      sequence: 13,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "msg-E 新输入" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t4",
      sequence: 14,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "msg-F 新回复" }] },
    },
    turnResult("t4", 15),
    // C2 边界：输入 [b1, s1, C', D', E]，遮蔽 [0-3]。
    {
      type: "control_boundary",
      sessionId: "s",
      turnId: "t5",
      sequence: 16,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preTokens: 200,
          postTokens: 50,
          messagesSummarized: 4,
          shadowedRanges: [{ fromIndex: 0, toIndex: 3 }],
        },
      },
    },
    // C2 产物落库。
    {
      type: "durable_message",
      sessionId: "s",
      turnId: "t5",
      sequence: 17,
      createdAt,
      message: {
        role: "user",
        metadata: { compactReplacement: true },
        content: [{ type: "text", text: "msg-b2 二次摘要" }],
      },
    },
    turnResult("t5", 18),
  ];
  return entries;
}

test("replayShadowedMessages：多次压缩时恢复最后一次压缩的输入区间（不串位）", () => {
  const entries = makeMultiCompactedTranscript();
  const restored = replayShadowedMessages(entries);
  // C2 输入区间 = C1 产物 + 新消息：[b1, s1, C', D', E]，遮蔽 [0-3]。
  assert.deepEqual(
    restored.messages.map(messageText),
    ["msg-b1 摘要", "msg-s1 保留", "msg-C' 重放", "msg-D' 重放"],
    "恢复最后一次压缩被遮蔽的 C1 产物，而非第一次压缩的旧消息",
  );
  assert.deepEqual(restored.matchedIndexes, [0, 1, 2, 3]);
  assert.equal(restored.diagnostics.length, 0, "对齐自检通过");
});

test("replayShadowedMessages：投影区间缺消息时产出对齐诊断而非静默错位", () => {
  const entries = makeMultiCompactedTranscript();
  // 篡改 C2 边界遮蔽全部 6 条输入 [0-5]。
  const widened = entries.map(entry =>
    entry.type === "control_boundary" &&
    entry.boundary.kind === "compact" &&
    "subtype" in entry.boundary &&
    entry.boundary.subtype === "compact_boundary"
      ? {
          ...entry,
          boundary: {
            ...entry.boundary,
            compactMetadata: {
              ...entry.boundary.compactMetadata,
              shadowedRanges: [{ fromIndex: 0, toIndex: 5 }],
            },
          },
        }
      : entry,
  );
  // 移除一条 C1 产物（模拟持久化失败被吞）→ 投影 5 条，期望 6 条。
  const tampered = widened.filter(entry => !("message" in entry) || messageText(entry.message) !== "msg-s1 保留");
  const restored = replayShadowedMessages(tampered);
  assert.equal(restored.messages.length, 5);
  assert.equal(restored.diagnostics.length, 1, "还原数少于期望时提示");
  assert.equal(restored.diagnostics[0]!.code, "shadowed_message_alignment");
});

test("replayShadowedMessagesAt：恢复指定（非最后一次）压缩边界的被遮蔽原文", () => {
  const entries = makeMultiCompactedTranscript();
  const c1BoundaryIndex = entries.findIndex(
    entry =>
      entry.type === "control_boundary" &&
      entry.boundary.kind === "compact" &&
      "subtype" in entry.boundary &&
      entry.boundary.subtype === "compact_boundary" &&
      entry.boundary.compactMetadata.messagesSummarized === 2,
  );
  const c2BoundaryIndex = entries.findIndex(
    entry =>
      entry.type === "control_boundary" &&
      entry.boundary.kind === "compact" &&
      "subtype" in entry.boundary &&
      entry.boundary.subtype === "compact_boundary" &&
      entry.boundary.compactMetadata.messagesSummarized === 4,
  );
  assert.ok(c1BoundaryIndex > 0 && c2BoundaryIndex > c1BoundaryIndex);

  // C1 边界：遮蔽 [0-1] → 首次压缩前的旧消息原文。
  const first = replayShadowedMessagesAt(entries, c1BoundaryIndex);
  assert.deepEqual(
    first.messages.map(messageText),
    ["msg-A 输入", "msg-B 回复"],
    "指定 C1 边界恢复第一次压缩被遮蔽的原文，而非最后一次压缩的产物",
  );
  assert.deepEqual(first.matchedIndexes, [0, 1]);
  assert.equal(first.diagnostics.length, 0);

  // C2 边界：遮蔽 [0-3] → C1 产物（与 replayShadowedMessages 一致）。
  const second = replayShadowedMessagesAt(entries, c2BoundaryIndex);
  assert.deepEqual(second.messages.map(messageText), ["msg-b1 摘要", "msg-s1 保留", "msg-C' 重放", "msg-D' 重放"]);
  assert.deepEqual(second.matchedIndexes, [0, 1, 2, 3]);
  assert.equal(second.diagnostics.length, 0);
});

test("replayShadowedMessagesAt：非法边界索引返回空（向后兼容）", () => {
  const entries = makeCompactedTranscript([{ fromIndex: 0, toIndex: 1 }]);
  // 普通消息条目索引、越界索引、无 shadowedRanges 的边界均返回空。
  assert.deepEqual(replayShadowedMessagesAt(entries, 0), {
    messages: [],
    matchedIndexes: [],
    diagnostics: [],
  });
  assert.deepEqual(replayShadowedMessagesAt(entries, 999), {
    messages: [],
    matchedIndexes: [],
    diagnostics: [],
  });
  const noRanges = entries.filter(entry => !(entry.type === "control_boundary" && "compactMetadata" in entry.boundary));
  const boundaryIndex = noRanges.findIndex(
    entry =>
      entry.type === "control_boundary" &&
      entry.boundary.kind === "compact" &&
      "subtype" in entry.boundary &&
      entry.boundary.subtype === "compact_boundary",
  );
  assert.deepEqual(replayShadowedMessagesAt(noRanges, boundaryIndex), {
    messages: [],
    matchedIndexes: [],
    diagnostics: [],
  });
});

test("replayShadowedMessagesAt：mid-turn 压缩时未完成 turn 的已落库消息纳入还原（不做 turn 完成过滤）", () => {
  // 压缩发生在 t2 中途：t2 的 assistant 消息已落库（durable），但 t2 无
  // turn_result。遮蔽重建是纯展示用途，压缩发生时已落库的消息就应还原，
  // turn 完成状态与「压缩输入当时的 messages」无关。
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t1",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "t1 输入" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "t1 回复" }] },
    },
    turnResult("t1", 3),
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t2",
      sequence: 4,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "t2 输入" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t2",
      sequence: 5,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "t2 中途回复（已落库）" }] },
    },
    // 无 t2 的 turn_result —— mid-turn 压缩。
    {
      type: "control_boundary",
      sessionId: "s",
      turnId: "t2",
      sequence: 6,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preTokens: 160,
          postTokens: 40,
          messagesSummarized: 4,
          shadowedRanges: [{ fromIndex: 0, toIndex: 3 }],
        },
      },
    },
  ];
  const boundaryIndex = entries.findIndex(entry => entry.type === "control_boundary");
  const restored = replayShadowedMessagesAt(entries, boundaryIndex);
  assert.deepEqual(
    restored.messages.map(messageText),
    ["t1 输入", "t1 回复", "t2 输入", "t2 中途回复（已落库）"],
    "未完成 turn 的已落库消息同样纳入遮蔽还原，不被 turn 完成状态过滤",
  );
  assert.equal(restored.diagnostics.length, 0);
});
