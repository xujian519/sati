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
});
