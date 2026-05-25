import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlTranscriptWriter,
  SUBAGENT_PROMPT_PREVIEW_BYTES,
  SUBAGENT_SUMMARY_PREVIEW_BYTES,
  truncatePreview,
} from "../../../src/session/index.js";

function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-c3-"));
  return join(dir, "session.jsonl");
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

test("C3.S1 recordSubagentStarted writes a started reference with truncated prompt", async () => {
  const path = makeTempPath();
  const writer = new JsonlTranscriptWriter({ path, now: () => new Date("2026-01-01T00:00:00Z") });
  await writer.recordSubagentStarted("session-1", "turn-1", {
    subagentId: "uuid-1",
    subagentType: "explore",
    prompt: "find foo",
    transcriptRelativePath: "session/subagents/uuid-1.jsonl",
    subagentSessionId: "sub-sess",
  });
  const lines = readJsonl(path);
  assert.equal(lines.length, 1);
  const entry = lines[0] as Record<string, unknown>;
  assert.equal(entry.type, "subagent_started");
  assert.equal(entry.subagentId, "uuid-1");
  assert.equal(entry.subagentType, "explore");
  assert.equal(entry.promptPreview, "find foo");
  assert.equal(entry.promptTruncated, false);
  assert.equal(entry.transcriptRelativePath, "session/subagents/uuid-1.jsonl");
});

test("C3.S1 recordSubagentStarted truncates oversize prompts at SUBAGENT_PROMPT_PREVIEW_BYTES", async () => {
  const path = makeTempPath();
  const writer = new JsonlTranscriptWriter({ path });
  const long = "a".repeat(SUBAGENT_PROMPT_PREVIEW_BYTES * 4);
  await writer.recordSubagentStarted("s", "t", {
    subagentId: "uuid-x",
    subagentType: "general-purpose",
    prompt: long,
    transcriptRelativePath: "subagents/uuid-x.jsonl",
  });
  const entry = readJsonl(path)[0] as Record<string, unknown>;
  assert.equal(entry.promptTruncated, true);
  assert.ok(typeof entry.promptPreview === "string");
  assert.ok(
    Buffer.byteLength(entry.promptPreview as string, "utf8") <= SUBAGENT_PROMPT_PREVIEW_BYTES,
  );
});

test("C3.S1 recordSubagentCompleted writes a completed reference with truncated summary + usage", async () => {
  const path = makeTempPath();
  const writer = new JsonlTranscriptWriter({ path });
  await writer.recordSubagentCompleted("s", "t", {
    subagentId: "uuid-2",
    subagentType: "plan",
    summary: "Scope: did x\nResult: ok",
    usage: { inputTokens: 50, outputTokens: 80, totalTokens: 130 },
    turns: 3,
    durationMs: 412,
  });
  const entry = readJsonl(path)[0] as Record<string, unknown>;
  assert.equal(entry.type, "subagent_completed");
  assert.equal(entry.summaryPreview, "Scope: did x\nResult: ok");
  assert.equal(entry.summaryTruncated, false);
  assert.deepEqual(entry.usage, { inputTokens: 50, outputTokens: 80, totalTokens: 130 });
  assert.equal(entry.turns, 3);
  assert.equal(entry.durationMs, 412);
});

test("C3.S1 recordSubagentCompleted caps summary at SUBAGENT_SUMMARY_PREVIEW_BYTES", async () => {
  const path = makeTempPath();
  const writer = new JsonlTranscriptWriter({ path });
  const huge = "y".repeat(SUBAGENT_SUMMARY_PREVIEW_BYTES * 2);
  await writer.recordSubagentCompleted("s", "t", {
    subagentId: "uuid-3",
    subagentType: "explore",
    summary: huge,
    turns: 1,
    durationMs: 1,
  });
  const entry = readJsonl(path)[0] as Record<string, unknown>;
  assert.equal(entry.summaryTruncated, true);
  assert.ok(
    Buffer.byteLength(entry.summaryPreview as string, "utf8") <= SUBAGENT_SUMMARY_PREVIEW_BYTES,
  );
});

test("C3.S2 forSubagent derives an independent writer at the resolved path", async () => {
  const path = makeTempPath();
  const writer = new JsonlTranscriptWriter({
    path,
    subagentTranscriptPath: (id) => join(path.replace(/\.jsonl$/, ""), "subagents", `${id}.jsonl`),
  });
  const handle = writer.forSubagent("uuid-1");
  assert.equal(handle.subagentId, "uuid-1");
  assert.match(handle.transcriptPath, /subagents[/\\]uuid-1\.jsonl$/);

  await handle.writer.recordEntry({
    type: "session_metadata",
    sessionId: "sub",
    turnId: "t",
    sequence: 1,
    createdAt: new Date().toISOString(),
    metadata: { title: "subagent" },
  });
  const sidechainEntries = readJsonl(handle.transcriptPath);
  assert.equal(sidechainEntries.length, 1);
  // Parent path stays empty because we did not write to it.
  assert.throws(() => readFileSync(path, "utf8"));
});

test("C3 truncatePreview byte-level (not char-level) cap", () => {
  const wide = "汉".repeat(2000); // 3 bytes per char
  const { preview, truncated } = truncatePreview(wide, 1024);
  assert.ok(Buffer.byteLength(preview, "utf8") <= 1024);
  assert.equal(truncated, true);
});

test("C3 truncatePreview returns input unchanged below cap", () => {
  const small = "abc";
  const { preview, truncated } = truncatePreview(small, 1024);
  assert.equal(preview, small);
  assert.equal(truncated, false);
});
