import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlTranscriptWriter,
  replaySubagentTranscript,
  replayTranscriptEntries,
  type AgentSubagentStartedTranscriptEntry,
  type AgentSubagentCompletedTranscriptEntry,
} from "../../../src/session/index.js";
import type { AgentTranscriptEntry } from "../../../src/session/index.js";

function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "politdeck-c3-"));
  return join(dir, "session.jsonl");
}

test("C3.S5 replaySubagentTranscript handles missing file gracefully", async () => {
  const out = await replaySubagentTranscript("/no/such/path.jsonl");
  assert.equal(out.messages.length, 0);
  assert.ok(out.diagnostics.some((d) => d.code === "transcript_missing"));
});

test("C3.S5 replaySubagentTranscript reads sidechain JSONL and returns messages", async () => {
  const path = makeTempPath();
  const writer = new JsonlTranscriptWriter({ path, now: () => new Date("2026-01-01T00:00:00Z") });
  await writer.recordAcceptedInput("sub", "t1", [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
  await writer.recordDurableMessage("sub", "t1", {
    role: "assistant",
    content: [{ type: "text", text: "Scope: ok\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none" }],
  });
  await writer.recordTurnResult("sub", "t1", {
    type: "success",
    sessionId: "sub",
    turnId: "t1",
    completedAt: "2026-01-01T00:00:00Z",
    stopReason: "completed",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-01-01T00:00:00Z",
  });

  const out = await replaySubagentTranscript(path);
  assert.equal(out.diagnostics.filter((d) => d.severity === "error").length, 0);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0]?.role, "user");
  assert.equal(out.messages[1]?.role, "assistant");
});

test("C3 main replay skips subagent_started/completed entries (lazy load)", () => {
  const start: AgentSubagentStartedTranscriptEntry = {
    type: "subagent_started",
    sessionId: "main",
    turnId: "t1",
    sequence: 1,
    createdAt: "2026-01-01T00:00:00Z",
    subagentId: "uuid-1",
    subagentType: "explore",
    promptPreview: "find foo",
    promptTruncated: false,
    transcriptRelativePath: "subagents/uuid-1.jsonl",
  };
  const done: AgentSubagentCompletedTranscriptEntry = {
    type: "subagent_completed",
    sessionId: "main",
    turnId: "t1",
    sequence: 2,
    createdAt: "2026-01-01T00:00:00Z",
    subagentId: "uuid-1",
    subagentType: "explore",
    summaryPreview: "Scope: ok\n...",
    summaryTruncated: false,
    turns: 2,
    durationMs: 100,
  };
  const entries: AgentTranscriptEntry[] = [start, done];
  const replay = replayTranscriptEntries(entries);
  assert.equal(replay.messages.length, 0);
  assert.equal(replay.diagnostics.length, 0);
});

test("C3.S5 replay tolerates corrupt sidechain JSONL (line-level)", async () => {
  const path = makeTempPath();
  writeFileSync(path, "{not json\n");
  const out = await replaySubagentTranscript(path);
  assert.ok(out.diagnostics.some((d) => d.code === "transcript_line_invalid"));
});
