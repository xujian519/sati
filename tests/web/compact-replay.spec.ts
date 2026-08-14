import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

test("web history shows original transcript while hiding compact replacement messages", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-compact-web-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-compact-web-home-"));
  try {
    const sessionKey = "web:s_compact_replay";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });

    await storage.transcript.recordAcceptedInput(sessionKey, "turn-old", [
      { role: "user", content: [{ type: "text", text: "old user request before compact" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-old", {
      role: "assistant",
      content: [
        { type: "thinking", text: "old thinking before compact" },
        { type: "text", text: "old answer before compact" },
      ],
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-old", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-old",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-08-02T00:00:00.000Z",
      completedAt: "2026-08-02T00:00:01.000Z",
    });
    await storage.transcript.recordControlBoundary?.(sessionKey, "turn-compact", {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        compactionId: "compact-1",
        trigger: "auto",
        preTokens: 120,
        postTokens: 40,
        messagesSummarized: 2,
        shadowedRanges: [{ fromIndex: 0, toIndex: 1 }],
      },
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-compact", {
      role: "assistant",
      metadata: { compactReplacement: true },
      content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\ncompact summary" }],
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-compact", {
      role: "user",
      metadata: { compactReplacement: true },
      content: [{ type: "text", text: "replacement tail should stay model-visible only" }],
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-compact", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-compact",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-08-02T00:00:02.000Z",
      completedAt: "2026-08-02T00:00:03.000Z",
    });

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const text = replay.messages.map(message => message.text ?? "").join("\n");
    const compactBoundary = replay.messages.find(message => message.kind === "compact_boundary");

    // 压缩边界现在作为 WebMessage 投影出来（payload 内嵌 shadowedRanges 与被遮蔽原文）
    assert.ok(compactBoundary);
    assert.equal(compactBoundary.role, "system");
    assert.equal(compactBoundary.source, "history");
    const payload = compactBoundary.payload as Record<string, unknown>;
    assert.deepEqual(payload.shadowedRanges, [{ fromIndex: 0, toIndex: 1 }]);
    assert.equal(compactBoundary.id, "web:s_compact_replay-compact-compact-1");
    const shadowedMessages = payload.shadowedMessages as Array<{ kind: string; text?: string }>;
    assert.ok(Array.isArray(shadowedMessages));
    // shadowedRanges [0,1] 覆盖压缩输入前两条消息（user 请求 + assistant 回复；
    // assistant 的 thinking/text 块各自拆成独立 WebMessage）
    assert.ok(shadowedMessages.length >= 2);
    assert.equal(shadowedMessages[0]?.kind, "text");
    assert.equal(shadowedMessages[0]?.text, "old user request before compact");
    assert.ok(
      shadowedMessages.some(message => message.text === "old answer before compact"),
      "被遮蔽的 assistant 原文应内嵌在 payload.shadowedMessages",
    );
    // 压缩边界出现在其插入位置（原文消息之后）
    const boundaryIndex = replay.messages.indexOf(compactBoundary);
    assert.ok(boundaryIndex >= 2, `expected boundary after original messages, got index ${boundaryIndex}`);
    assert.match(text, /old user request before compact/);
    assert.match(text, /old thinking before compact/);
    assert.match(text, /old answer before compact/);
    assert.doesNotMatch(text, /\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
    assert.doesNotMatch(text, /compact summary/);
    assert.doesNotMatch(text, /replacement tail should stay model-visible only/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
