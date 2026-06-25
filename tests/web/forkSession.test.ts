import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";

test("assistant-message fork preserves history through the assistant response", async () => {
  const fixture = await createForkFixture();
  try {
    const result = await forkWebSession({
      sessionKey: fixture.sessionKey,
      projectKey: fixture.projectRoot,
      fromEntryId: "assistant-entry",
    }, {
      projectRoot: fixture.projectRoot,
      pilotHome: fixture.pilotHome,
      now: () => new Date("2026-06-25T09:00:00.000Z"),
    });

    assert.equal(result.prefillText, "");
    assert.equal(result.carriedMessageCount, 2);

    const forkEntries = await readForkEntries(fixture.chatDir, result.newSessionKey);
    assert.deepEqual(forkEntries.map((entry) => entry.type), [
      "accepted_input",
      "assistant_message",
      "session_metadata",
    ]);
    assert.equal(forkEntries[0].sessionId, result.newSessionKey);
    assert.equal(forkEntries[1].sessionId, result.newSessionKey);
    assert.equal(forkEntries[1].entryId, "assistant-entry");

    const assistant = forkEntries[1];
    assert.equal(assistant.type, "assistant_message");
    assert.deepEqual(assistant.message.content, [{ type: "text", text: "Done summary" }]);
    assert.deepEqual(assistant.message.metadata?.forkCarryover, {
      sourceSessionId: fixture.sessionKey,
      sourceTurnId: "turn-1",
    });

    const metadata = forkEntries[2];
    assert.equal(metadata.type, "session_metadata");
    assert.equal(metadata.parentEntryId, "assistant-entry");
    assert.equal(metadata.metadata.parentSessionId, fixture.sessionKey);
    assert.equal(metadata.metadata.forkedFromTurnId, "turn-1");
    assert.equal(metadata.metadata.firstPrompt, "Write a summary");
  } finally {
    await fixture.cleanup();
  }
});

test("user-message fork keeps old prefill-before-turn behavior", async () => {
  const fixture = await createForkFixture();
  try {
    const result = await forkWebSession({
      sessionKey: fixture.sessionKey,
      projectKey: fixture.projectRoot,
      fromEntryId: "user-entry",
    }, {
      projectRoot: fixture.projectRoot,
      pilotHome: fixture.pilotHome,
      now: () => new Date("2026-06-25T09:00:00.000Z"),
    });

    assert.equal(result.prefillText, "Write a summary");
    assert.equal(result.carriedMessageCount, 0);

    const forkEntries = await readForkEntries(fixture.chatDir, result.newSessionKey);
    assert.deepEqual(forkEntries.map((entry) => entry.type), ["session_metadata"]);
    assert.equal(forkEntries[0].parentEntryId, null);
  } finally {
    await fixture.cleanup();
  }
});

async function createForkFixture(): Promise<{
  pilotHome: string;
  projectRoot: string;
  chatDir: string;
  sessionKey: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-test-"));
  const pilotHome = resolve(root, "pilot-home");
  const projectRoot = resolve(root, "project");
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  const sessionKey = "web:s_source";
  await mkdir(chatDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-25T08:00:00.000Z",
      entryId: "user-entry",
      parentEntryId: null,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Write a summary" }],
      }],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-25T08:00:01.000Z",
      entryId: "assistant-entry",
      parentEntryId: "user-entry",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done summary" }],
      },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-06-25T08:00:02.000Z",
      entryId: "result-entry",
      parentEntryId: "assistant-entry",
      result: {
        type: "success",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-06-25T08:00:00.000Z",
        sessionId: sessionKey,
        turnId: "turn-1",
        completedAt: "2026-06-25T08:00:02.000Z",
      },
    },
  ];
  const transcriptPath = resolve(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
  await writeFile(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

  return {
    pilotHome,
    projectRoot,
    chatDir,
    sessionKey,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function readForkEntries(chatDir: string, sessionKey: string): Promise<AgentTranscriptEntry[]> {
  const path = resolve(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as AgentTranscriptEntry);
}
