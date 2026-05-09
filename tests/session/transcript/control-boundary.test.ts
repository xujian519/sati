import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlTranscriptWriter } from "../../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";
import {
  findLastCompactBoundaryIndex,
  replayTranscriptEntries,
} from "../../../src/session/transcript/TranscriptReplay.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

const turnId = "turn-1";
const sessionId = "session-1";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

test("JsonlTranscriptWriter persists compact_boundary entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-tx-"));
  try {
    const writer = new JsonlTranscriptWriter({ path: join(dir, "session.jsonl") });
    await writer.recordAcceptedInput(sessionId, turnId, [userMessage("first")]);
    await writer.recordControlBoundary(sessionId, turnId, {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        trigger: "auto",
        preTokens: 12345,
        messagesSummarized: 3,
        preCompactDiscoveredTools: ["read_file"],
      },
    });
    await writer.recordAcceptedInput(sessionId, "turn-2", [userMessage("after compact")]);

    const read = await readTranscript(join(dir, "session.jsonl"));
    const boundaryIndex = findLastCompactBoundaryIndex(read.entries);
    assert.ok(boundaryIndex >= 0);
    const entry = read.entries[boundaryIndex];
    assert.equal(entry.type, "control_boundary");
    if (entry.type === "control_boundary" && entry.boundary.kind === "compact" && "subtype" in entry.boundary) {
      assert.equal(entry.boundary.subtype, "compact_boundary");
      if (entry.boundary.subtype === "compact_boundary") {
        assert.equal(entry.boundary.compactMetadata.trigger, "auto");
        assert.equal(entry.boundary.compactMetadata.preTokens, 12345);
        assert.deepEqual(entry.boundary.compactMetadata.preCompactDiscoveredTools, ["read_file"]);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replayTranscriptEntries skips messages before the last compact boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-tx-"));
  try {
    const writer = new JsonlTranscriptWriter({ path: join(dir, "session.jsonl") });
    await writer.recordAcceptedInput(sessionId, "turn-1", [userMessage("before-1")]);
    await writer.recordTurnResult(sessionId, "turn-1", {
      type: "success",
      sessionId,
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    await writer.recordControlBoundary(sessionId, "turn-1", {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "manual", preTokens: 1000 },
    });
    await writer.recordAcceptedInput(sessionId, "turn-2", [userMessage("after-1")]);
    await writer.recordTurnResult(sessionId, "turn-2", {
      type: "success",
      sessionId,
      turnId: "turn-2",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    });

    const read = await readTranscript(join(dir, "session.jsonl"));
    const replay = replayTranscriptEntries(read.entries);
    assert.equal(replay.messages.length, 1);
    assert.equal((replay.messages[0]?.content[0] as { text: string }).text, "after-1");
    assert.ok(replay.lastCompactBoundaryIndex !== undefined);
    assert.equal(replay.lastCompactBoundary?.boundary.kind, "compact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
