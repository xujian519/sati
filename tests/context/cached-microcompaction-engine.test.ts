import test from "node:test";
import assert from "node:assert/strict";
import {
  CachedMicroCompactionEngine,
  COMPACTABLE_TOOL_NAMES,
} from "../../src/context/compaction/CachedMicroCompactionEngine.js";
import type { CanonicalMessage } from "../../src/model/index.js";

function buildSession(numTurns: number, toolName = "read_file"): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  messages.push({ role: "user", content: [{ type: "text", text: "start" }] });
  for (let i = 0; i < numTurns; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "tool_call", id: `tu_${i}`, name: toolName, input: { path: `f${i}` } },
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: `tu_${i}`,
          content: [{ type: "text", text: `result-${i}` }],
        },
      ],
    });
  }
  return messages;
}

test("A4.M5 disabled by default → no breakpoints", () => {
  const e = new CachedMicroCompactionEngine();
  const r = e.apply({ messages: buildSession(10), protocol: "anthropic" });
  assert.equal(r.applied, false);
  assert.deepEqual(r.cacheBreakpoints, []);
});

test("A4.M2 non-Anthropic provider → no-op even when enabled", () => {
  const e = new CachedMicroCompactionEngine({ enabled: true });
  const r = e.apply({ messages: buildSession(10), protocol: "openai" });
  assert.equal(r.applied, false);
});

test("A4.M3 subagent → no-op", () => {
  const e = new CachedMicroCompactionEngine({ enabled: true });
  const r = e.apply({
    messages: buildSession(10),
    protocol: "anthropic",
    isSubagent: true,
  });
  assert.equal(r.applied, false);
});

test("A4.M1 only COMPACTABLE_TOOL_NAMES are eligible (ask_user_question is NOT)", () => {
  // Create 10 turns of ask_user_question (NOT compactable) — should be no-op.
  const e = new CachedMicroCompactionEngine({ enabled: true, liveThreshold: 0 });
  assert.equal(COMPACTABLE_TOOL_NAMES.has("ask_user_question"), false);
  const r = e.apply({
    messages: buildSession(10, "ask_user_question"),
    protocol: "anthropic",
  });
  assert.equal(r.applied, false);
  assert.equal(r.eligibleToolCallIds.length, 0);
});

test("A4 enabled + Anthropic + 10 read_file turns + threshold=4 → 6 breakpoints", () => {
  const e = new CachedMicroCompactionEngine({ enabled: true, liveThreshold: 4 });
  const messages = buildSession(10, "read_file");
  const r = e.apply({ messages, protocol: "anthropic" });
  // 10 eligible user messages, keep 4 live → 6 aged.
  // M6: each breakpoint goes on the message *immediately before* the aged
  // user message → 6 unique breakpoints.
  assert.equal(r.applied, true);
  assert.equal(r.cacheBreakpoints.length, 6);
  // First aged user is at index 2 (after start + first assistant), so first
  // breakpoint is at index 1 (the assistant message).
  assert.equal(r.cacheBreakpoints[0], 1);
  assert.equal(r.eligibleToolCallIds.length, 10);
});

test("A4 ≤ liveThreshold eligible messages → no breakpoints", () => {
  const e = new CachedMicroCompactionEngine({ enabled: true, liveThreshold: 4 });
  const r = e.apply({ messages: buildSession(3), protocol: "anthropic" });
  assert.equal(r.applied, false);
  assert.deepEqual(r.cacheBreakpoints, []);
});

test("A4.M7 validateCacheHit recognizes cache_read_input_tokens > 0", () => {
  const e = new CachedMicroCompactionEngine({ enabled: true });
  assert.equal(e.validateCacheHit(undefined), false);
  assert.equal(e.validateCacheHit({}), false);
  assert.equal(e.validateCacheHit({ cacheReadTokens: 0 }), false);
  assert.equal(e.validateCacheHit({ cacheReadTokens: 42 }), true);
});

test("A4 mixed tool names → only COMPACTABLE ones contribute", () => {
  const e = new CachedMicroCompactionEngine({ enabled: true, liveThreshold: 0 });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "boot" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "ok", name: "read_file", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "ok",
          content: [{ type: "text", text: "x" }],
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "skip", name: "ask_user_question", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "skip",
          content: [{ type: "text", text: "answer" }],
        },
      ],
    },
  ];
  const r = e.apply({ messages, protocol: "anthropic" });
  assert.equal(r.eligibleToolCallIds.length, 1);
  assert.equal(r.eligibleToolCallIds[0], "ok");
});
