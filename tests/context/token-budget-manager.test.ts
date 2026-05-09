import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_MAX_TOKEN_SIZE,
  TokenBudgetManager,
  bytesPerTokenForExt,
} from "../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("TokenBudgetManager char/4 estimator", () => {
  const m = new TokenBudgetManager();
  assert.equal(m.estimateTextTokens(""), 0);
  assert.equal(m.estimateTextTokens("abcd"), 1);
  assert.equal(m.estimateTextTokens("a".repeat(40)), 10);
});

test("TokenBudgetManager applies multimedia constant for images / pdf", () => {
  const m = new TokenBudgetManager({ multimediaTokens: 1234 });
  assert.equal(
    m.estimateBlockTokens({ type: "image", source: "base64", data: "x", mimeType: "image/png" }),
    1234,
  );
  assert.equal(
    m.estimateBlockTokens({ type: "pdf", source: "base64", data: "x", mimeType: "application/pdf", bytes: 0 }),
    1234,
  );
});

test("TokenBudgetManager evaluate produces ok / warning / blocking by ratio", () => {
  const m = new TokenBudgetManager({ warningRatio: 0.5, blockingRatio: 0.9 });
  // 100 chars → 25 tokens + 4 overhead = 29 tokens.
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "a".repeat(100) }] },
  ];
  // ratio 29/200 ≈ 0.14 → ok
  assert.equal(m.evaluate(messages, 200).state, "ok");
  // ratio 29/50 = 0.58 → warning
  assert.equal(m.evaluate(messages, 50).state, "warning");
  // ratio 29/30 ≈ 0.96 → blocking
  assert.equal(m.evaluate(messages, 30).state, "blocking");
});

// --- A2 behavior alignment (T1..T13) ---

test("A2.T1 estimateTextTokens uses Math.round (legacy parity)", () => {
  const m = new TokenBudgetManager();
  // round(5/4)=1; ceil would give 2 — this test fails on the previous ceil impl.
  assert.equal(m.estimateTextTokens("a".repeat(5)), 1);
  // round(7/4)=2; ceil gives 2 — same result here.
  assert.equal(m.estimateTextTokens("a".repeat(7)), 2);
  // round(10/4)=round(2.5)=3 (Math.round rounds half-away-from-zero in JS for
  // positive numbers); ceil gives 3 — same here, sanity check only.
  assert.equal(m.estimateTextTokens("a".repeat(10)), 3);
});

test("A2.T2 bytesPerTokenForExt: JSON-like = 2, others = 4", () => {
  assert.equal(bytesPerTokenForExt("json"), 2);
  assert.equal(bytesPerTokenForExt(".JSON"), 2);
  assert.equal(bytesPerTokenForExt("yaml"), 2);
  assert.equal(bytesPerTokenForExt("yml"), 2);
  assert.equal(bytesPerTokenForExt("ndjson"), 2);
  assert.equal(bytesPerTokenForExt("ts"), 4);
  assert.equal(bytesPerTokenForExt("md"), 4);
  assert.equal(bytesPerTokenForExt(undefined), 4);
  assert.equal(bytesPerTokenForExt(null), 4);
  assert.equal(bytesPerTokenForExt(""), 4);
});

test("A2.T3 estimateForFileType routes via ext", () => {
  const m = new TokenBudgetManager();
  // 100 chars json → 100/2 = 50.
  assert.equal(m.estimateForFileType("a".repeat(100), "json"), 50);
  // 100 chars md → 100/4 = 25.
  assert.equal(m.estimateForFileType("a".repeat(100), "md"), 25);
  assert.equal(m.estimateForFileType("", "json"), 0);
});

test("A2.T5 thinking blocks count text only (signature ignored)", () => {
  const m = new TokenBudgetManager();
  const t = m.estimateForBlock({
    type: "thinking",
    text: "a".repeat(40),
    signature: "long-signature-that-must-not-be-counted",
  });
  assert.equal(t, 10);
});

test("A2.T6/T7/T8 image / pdf / audio use IMAGE_MAX_TOKEN_SIZE", () => {
  const m = new TokenBudgetManager();
  assert.equal(
    m.estimateForBlock({ type: "image", source: "base64", data: "x", mimeType: "image/png" }),
    IMAGE_MAX_TOKEN_SIZE,
  );
  assert.equal(
    m.estimateForBlock({ type: "pdf", source: "base64", data: "x", mimeType: "application/pdf", bytes: 0 }),
    IMAGE_MAX_TOKEN_SIZE,
  );
  assert.equal(
    m.estimateForBlock({ type: "audio", source: "base64", data: "x", mimeType: "audio/wav" }),
    IMAGE_MAX_TOKEN_SIZE,
  );
});

test("A2.T9 tool_call concatenates name + JSON.stringify(input)", () => {
  const m = new TokenBudgetManager();
  // name="bash" (4 chars) + JSON.stringify({"command":"ls"}) = `{"command":"ls"}` (16 chars)
  // total 20 chars / 4 = 5.
  const t = m.estimateForBlock({
    type: "tool_call",
    id: "x",
    name: "bash",
    input: { command: "ls" },
  });
  assert.equal(t, 5);
});

test("A2.T9 tool_call with undefined / null input falls back to name only", () => {
  const m = new TokenBudgetManager();
  // name="abcd" only → 1 token.
  assert.equal(
    m.estimateForBlock({ type: "tool_call", id: "x", name: "abcd", input: null }),
    1,
  );
  assert.equal(
    m.estimateForBlock({ type: "tool_call", id: "x", name: "abcd", input: undefined }),
    1,
  );
});

test("A2.T10 tool_result recurses inner text blocks", () => {
  const m = new TokenBudgetManager();
  const t = m.estimateForBlock({
    type: "tool_result",
    toolCallId: "x",
    content: [
      { type: "text", text: "a".repeat(40) }, // 10
      { type: "text", text: "a".repeat(20) }, // 5
    ],
  });
  assert.equal(t, 15);
});

test("A2.T13 tool_result_reference uses preview only", () => {
  const m = new TokenBudgetManager();
  const t = m.estimateForBlock({
    type: "tool_result_reference",
    toolCallId: "x",
    path: "/never-counted",
    originalBytes: 999_999_999,
    preview: "a".repeat(40),
    hasMore: true,
  });
  assert.equal(t, 10);
});

test("A2.T11 estimateForMessage adds perMessageOverhead", () => {
  const m = new TokenBudgetManager({ perMessageOverhead: 4 });
  const msg: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: "a".repeat(40) }],
  };
  // 4 (overhead) + 10 (text) = 14
  assert.equal(m.estimateForMessage(msg), 14);
});

test("A2.T12 estimateForMessagesWithPadding multiplies by 4/3 (ceil)", () => {
  const m = new TokenBudgetManager();
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "a".repeat(120) }] }, // 30 + 4 = 34
  ];
  // raw = 34; padded = ceil(34 * 4 / 3) = ceil(45.33) = 46
  assert.equal(m.estimateForMessagesWithPadding(messages), 46);
  // empty = 0
  assert.equal(m.estimateForMessagesWithPadding([]), 0);
});
