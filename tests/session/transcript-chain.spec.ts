import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationChain } from "../../src/session/transcript/TranscriptChain.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";

function entry(id: string, parent: string | null | undefined, seq: number): AgentTranscriptEntry {
  return {
    type: "assistant_message",
    sessionId: "s1",
    turnId: `t${seq}`,
    sequence: seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    entryId: id,
    parentEntryId: parent,
    message: { role: "assistant", content: [{ type: "text", text: `m${seq}` }] },
  };
}

test("buildConversationChain falls back to sequence order without entryIds", () => {
  const e1 = entry("a", null, 1);
  const e2 = entry("b", null, 2);
  // Strip ids to simulate pre-chain transcripts.
  const entries = [e1, e2].map(({ entryId: _id, parentEntryId: _p, ...rest }) => rest as AgentTranscriptEntry);
  const result = buildConversationChain(entries);
  assert.deepEqual(
    result.chain.map(e => e.sequence),
    [1, 2],
  );
  assert.deepEqual(
    result.leaves.map(e => e.sequence),
    [2],
  );
  assert.deepEqual(
    result.roots.map(e => e.sequence),
    [1],
  );
  assert.deepEqual(result.orphans, []);
  assert.equal(result.diagnostics[0]?.code, "transcript_entry_invalid");
});

test("buildConversationChain returns empty result for empty input", () => {
  const result = buildConversationChain([]);
  assert.deepEqual(result.chain, []);
  assert.deepEqual(result.leaves, []);
  assert.deepEqual(result.roots, []);
  assert.deepEqual(result.orphans, []);
  assert.ok(result.diagnostics.length > 0);
});

test("buildConversationChain follows a linear chain", () => {
  const a = entry("a", null, 1);
  const b = entry("b", "a", 2);
  const c = entry("c", "b", 3);
  const result = buildConversationChain([a, b, c]);
  assert.deepEqual(
    result.chain.map(e => e.entryId),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    result.leaves.map(e => e.entryId),
    ["c"],
  );
  assert.deepEqual(
    result.roots.map(e => e.entryId),
    ["a"],
  );
  assert.deepEqual(result.orphans, []);
});

test("buildConversationChain picks the longest branch from a fork", () => {
  const a = entry("a", null, 1);
  const b = entry("b", "a", 2);
  const c = entry("c", "a", 2);
  const d = entry("d", "b", 3);
  const result = buildConversationChain([a, b, c, d]);
  assert.deepEqual(
    result.chain.map(e => e.entryId),
    ["a", "b", "d"],
  );
  assert.deepEqual(result.leaves.map(e => e.entryId).sort(), ["c", "d"]);
  assert.deepEqual(
    result.roots.map(e => e.entryId),
    ["a"],
  );
  assert.deepEqual(result.orphans, []);
});

test("buildConversationChain reports orphans and appends them to the chain", () => {
  const a = entry("a", null, 1);
  const b = entry("b", "a", 2);
  const orphan = entry("x", "missing-parent", 3);
  const result = buildConversationChain([a, b, orphan]);
  assert.deepEqual(
    result.chain.map(e => e.entryId),
    ["a", "b", "x"],
  );
  assert.deepEqual(
    result.orphans.map(e => e.entryId),
    ["x"],
  );
  assert.equal(result.diagnostics[0]?.message.includes("missing parent"), true);
});

test("buildConversationChain recovers from a cycle by using the first entry as root", () => {
  const a = entry("a", "b", 1);
  const b = entry("b", "a", 2);
  const result = buildConversationChain([a, b]);
  assert.deepEqual(
    result.roots.map(e => e.entryId),
    ["a"],
  );
  assert.ok(result.diagnostics.some(d => d.message.includes("cycle")));
  // Both entries have children, so neither is a leaf.
  assert.deepEqual(result.leaves, []);
  // Cycle guard: the chain never revisits an entry (regression: previously
  // this crashed with "Maximum call stack size exceeded").
  assert.deepEqual(
    result.chain.map(e => e.entryId),
    ["a", "b"],
  );
});

test("buildConversationChain treats missing entryId entries as invisible to the graph", () => {
  const a = entry("a", null, 1);
  const noId = { ...entry("n", null, 2), entryId: undefined } as AgentTranscriptEntry;
  const b = entry("b", "a", 3);
  const result = buildConversationChain([a, noId, b]);
  assert.deepEqual(
    result.chain.map(e => e.entryId),
    ["a", "b"],
  );
  assert.deepEqual(
    result.roots.map(e => e.entryId),
    ["a"],
  );
});
