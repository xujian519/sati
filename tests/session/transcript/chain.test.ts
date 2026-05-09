import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationChain } from "../../../src/session/transcript/TranscriptChain.js";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";

function entry(id: string, parentId: string | null, seq: number): AgentTranscriptEntry {
  return {
    type: "accepted_input",
    sessionId: "s",
    turnId: "t",
    sequence: seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    entryId: id,
    parentEntryId: parentId,
    messages: [{ role: "user", content: [{ type: "text", text: id }] }],
  };
}

test("buildConversationChain builds a linear chain", () => {
  const entries = [entry("a", null, 1), entry("b", "a", 2), entry("c", "b", 3)];
  const result = buildConversationChain(entries);
  assert.deepEqual(result.chain.map((e) => e.entryId), ["a", "b", "c"]);
  assert.deepEqual(result.roots.map((e) => e.entryId), ["a"]);
  assert.deepEqual(result.leaves.map((e) => e.entryId), ["c"]);
  assert.equal(result.orphans.length, 0);
});

test("buildConversationChain picks the longest branch", () => {
  const entries = [
    entry("root", null, 1),
    entry("short", "root", 2),
    entry("long-1", "root", 3),
    entry("long-2", "long-1", 4),
  ];
  const result = buildConversationChain(entries);
  assert.deepEqual(result.chain.map((e) => e.entryId), ["root", "long-1", "long-2"]);
  assert.equal(result.leaves.length, 2);
});

test("buildConversationChain marks orphans with missing parent", () => {
  const entries = [entry("a", null, 1), entry("orphan", "missing", 2)];
  const result = buildConversationChain(entries);
  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0]?.entryId, "orphan");
  assert.ok(result.diagnostics.some((d) => d.message.includes("missing parent")));
  // Orphans are appended at the end of the chain.
  assert.deepEqual(result.chain.map((e) => e.entryId), ["a", "orphan"]);
});

test("buildConversationChain falls back to sequence order when no entryId", () => {
  const noIdEntries: AgentTranscriptEntry[] = [
    { type: "accepted_input", sessionId: "s", turnId: "t", sequence: 1, createdAt: "2026-01-01", messages: [] },
    { type: "accepted_input", sessionId: "s", turnId: "t", sequence: 2, createdAt: "2026-01-01", messages: [] },
  ];
  const result = buildConversationChain(noIdEntries);
  assert.equal(result.chain.length, 2);
  assert.ok(result.diagnostics.some((d) => d.message.includes("falling back to sequence")));
});

test("buildConversationChain handles empty entries", () => {
  const result = buildConversationChain([]);
  assert.equal(result.chain.length, 0);
  assert.equal(result.leaves.length, 0);
  assert.equal(result.roots.length, 0);
});
