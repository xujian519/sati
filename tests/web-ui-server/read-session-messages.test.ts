import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
import { createProjectId } from "../../src/pilot/index.js";

function makeFixture(projectRoot: string, pilotHome: string, sessionKey: string): void {
  const projectId = createProjectId(projectRoot);
  const chatDir = join(pilotHome, "projects", projectId, "chats");
  mkdirSync(chatDir, { recursive: true });
  const path = join(chatDir, `${sessionKey}.jsonl`);
  // Minimal transcript: an accepted_input + assistant message + turn_result
  // so replayTranscriptEntries keeps both messages.
  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello?" }] },
      ],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-01-01T00:00:00.500Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
      },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-01-01T00:00:01.000Z",
      result: {
        type: "success",
        sessionId: sessionKey,
        turnId: "turn-1",
        stopReason: "completed",
        usage: { totalTokens: 1 },
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    },
  ];
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(path, content + "\n");
}

test("readWebSessionMessages returns user + assistant messages in order", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:demo";
  try {
    makeFixture(projectRoot, pilotHome, sessionKey);
    const result = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, now: () => new Date("2026-05-09T00:00:00.000Z") },
    );
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, "user");
    assert.equal(result.messages[0].kind, "text");
    assert.equal(result.messages[0].text, "hello?");
    assert.equal(result.messages[1].role, "assistant");
    assert.equal(result.messages[1].text, "hi there");
    assert.equal(result.session.sessionKey, sessionKey);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("readWebSessionMessages paginates with cursor + limit", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-page-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:page";
  try {
    makeFixture(projectRoot, pilotHome, sessionKey);
    const page1 = await readWebSessionMessages(
      { sessionKey, limit: 1 },
      { projectRoot, pilotHome },
    );
    assert.equal(page1.messages.length, 1);
    assert.equal(page1.nextCursor, "1");
    assert.equal(page1.total, 2);

    const page2 = await readWebSessionMessages(
      { sessionKey, limit: 1, cursor: page1.nextCursor },
      { projectRoot, pilotHome },
    );
    assert.equal(page2.messages.length, 1);
    assert.equal(page2.nextCursor, undefined);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
