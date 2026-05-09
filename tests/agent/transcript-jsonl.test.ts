import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JsonlTranscriptWriter,
  createAgentProjectSessionStorage,
  readTranscript,
  replayTranscriptEntries,
} from "../../src/session/index.js";
import { getPilotProjectChatDir } from "../../src/pilot/index.js";

test("JsonlTranscriptWriter writes ordered transcript entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-agent-jsonl-"));
  try {
    const transcriptPath = path.join(root, "session.jsonl");
    const writer = new JsonlTranscriptWriter({
      path: transcriptPath,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await writer.recordAcceptedInput("s", "t", [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    await writer.recordDurableMessage("s", "t", { role: "assistant", content: [{ type: "text", text: "hi" }] });
    await writer.recordTurnResult("s", "t", {
      type: "success",
      sessionId: "s",
      turnId: "t",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
    });

    const read = await readTranscript(transcriptPath);
    const fileStat = await stat(transcriptPath);

    assert.deepEqual(read.entries.map((entry) => entry.type), ["accepted_input", "assistant_message", "turn_result"]);
    assert.deepEqual(read.entries.map((entry) => entry.sequence), [1, 2, 3]);
    assert.ok(read.entries.every((entry) => entry.entryId));
    assert.equal(read.entries[1]?.parentEntryId, read.entries[0]?.entryId);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.deepEqual(read.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readTranscript refuses oversized transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-agent-large-jsonl-"));
  try {
    const transcriptPath = path.join(root, "session.jsonl");
    await writeFile(transcriptPath, "x".repeat(32), "utf8");

    const read = await readTranscript(transcriptPath, { maxBytes: 8 });

    assert.equal(read.entries.length, 0);
    assert.equal(read.diagnostics[0]?.code, "transcript_too_large");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project session storage uses PilotDeck project chat directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-agent-project-"));
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: path.join(root, "repo"),
      pilotHome: path.join(root, "home"),
      sessionId: "session-1",
    });

    assert.equal(storage.chatDir, getPilotProjectChatDir(path.join(root, "repo"), path.join(root, "home")));
    assert.equal(storage.transcriptPath, path.join(storage.chatDir, "session-1.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readTranscript reports malformed lines and replay skips incomplete durable messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-agent-bad-jsonl-"));
  try {
    const transcriptPath = path.join(root, "session.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "accepted_input",
          sessionId: "s",
          turnId: "t",
          sequence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        }),
        JSON.stringify({
          type: "assistant_message",
          sessionId: "s",
          turnId: "t",
          sequence: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
        }),
        "{bad json",
      ].join("\n"),
      "utf8",
    );

    const read = await readTranscript(transcriptPath);
    const replay = replayTranscriptEntries(read.entries);

    assert.equal(read.diagnostics[0]?.code, "transcript_line_invalid");
    assert.equal(replay.messages.length, 1);
    assert.equal(replay.diagnostics[0]?.code, "transcript_entry_invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
