import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

test("newly generated history frames carry provider=sati and source=history", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-history-provider-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-history-provider-home-"));
  try {
    const sessionKey = "web:s_history_provider";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });

    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [
      { role: "user", content: [{ type: "text", text: "first user request" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "first assistant answer" }],
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-1", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-08-02T00:00:01.000Z",
      completedAt: "2026-08-02T00:00:02.000Z",
    });

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });

    assert.ok(replay.messages.length > 0, "expected at least one replayed frame");
    for (const message of replay.messages) {
      assert.equal(message.provider, "sati", "every replayed frame must carry the sati brand label");
      assert.equal(message.source, "history", "every replayed frame must be tagged as history");
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("incomplete-turn status frame carries provider=sati and source=history", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-history-provider-incomplete-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-history-provider-incomplete-home-"));
  try {
    const sessionKey = "web:s_history_provider_incomplete";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });

    // An assistant message without a matching turn_result marks the turn incomplete.
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-interrupted", [
      { role: "user", content: [{ type: "text", text: "request that got interrupted" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-interrupted", {
      role: "assistant",
      content: [{ type: "text", text: "partial answer before interruption" }],
    });

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });

    const statusFrames = replay.messages.filter(message => message.kind === "status");
    assert.equal(statusFrames.length, 1, "expected exactly one incomplete-turn status frame");
    for (const message of statusFrames) {
      assert.equal(message.provider, "sati");
      assert.equal(message.source, "history");
      assert.equal(message.role, "system");
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
