import { describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { normalizedToChatMessages } from "./useChatMessages";

const base = {
  sessionId: "session-1",
  provider: "sati" as const,
};

describe("compact boundary message conversion", () => {
  it("propagates compactionId from the normalized message", () => {
    const messages: NormalizedMessage[] = [
      {
        ...base,
        id: "compact-1",
        timestamp: "2026-07-21T10:00:00.000Z",
        kind: "compact_boundary",
        compactionId: "compact-test-1",
        trigger: "auto",
        preTokens: 120,
        postTokens: 40,
        messagesSummarized: 7,
        compactLevel: 1,
        compactStage: "full",
        compactStageLabel: "Full compaction",
      },
    ];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].isCompactBoundary).toBe(true);
    expect(result[0].compactionId).toBe("compact-test-1");
    expect(result[0].compactTrigger).toBe("auto");
    expect(result[0].messagesSummarized).toBe(7);
  });

  it("tolerates compact boundary messages without a compactionId (legacy history)", () => {
    const messages: NormalizedMessage[] = [
      {
        ...base,
        id: "compact-2",
        timestamp: "2026-07-21T10:00:01.000Z",
        kind: "compact_boundary",
        trigger: "manual",
        preTokens: 80,
      },
    ];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].isCompactBoundary).toBe(true);
    expect(result[0].compactionId).toBeUndefined();
  });

  it("propagates shadowedRanges and shadowedMessages from compactMetadata (history expansion)", () => {
    const messages: NormalizedMessage[] = [
      {
        ...base,
        id: "compact-3",
        timestamp: "2026-07-21T10:00:02.000Z",
        kind: "compact_boundary",
        compactionId: "compact-test-3",
        trigger: "auto",
        messagesSummarized: 2,
        compactMetadata: {
          shadowedRanges: [{ fromIndex: 0, toIndex: 1 }],
          shadowedMessages: [
            { kind: "text", role: "user", text: "old user request", timestamp: "2026-07-21T09:00:00.000Z" },
            { kind: "thinking", role: "assistant", text: "old thinking", timestamp: "2026-07-21T09:00:01.000Z" },
            { kind: "text", role: "assistant", text: "old answer", timestamp: "2026-07-21T09:00:02.000Z" },
            { kind: "tool_use", toolName: "read_file", toolCallId: "call-1", timestamp: "2026-07-21T09:00:03.000Z" },
          ],
        },
      },
    ];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].isCompactBoundary).toBe(true);
    expect(result[0].shadowedRanges).toEqual([{ fromIndex: 0, toIndex: 1 }]);
    expect(result[0].shadowedMessages).toHaveLength(4);
    expect(result[0].shadowedMessages?.[0]).toMatchObject({ kind: "text", role: "user", text: "old user request" });
    expect(result[0].shadowedMessages?.[3]).toMatchObject({
      kind: "tool_use",
      toolName: "read_file",
      toolCallId: "call-1",
    });
  });

  it("ignores malformed compactMetadata shadowed payloads", () => {
    const messages: NormalizedMessage[] = [
      {
        ...base,
        id: "compact-4",
        timestamp: "2026-07-21T10:00:03.000Z",
        kind: "compact_boundary",
        compactMetadata: {
          shadowedRanges: [{ fromIndex: "nope", toIndex: 1 }],
          shadowedMessages: [{ kind: 42, text: "broken" }],
        },
      },
    ];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].shadowedRanges).toBeUndefined();
    expect(result[0].shadowedMessages).toEqual([]);
  });
});
