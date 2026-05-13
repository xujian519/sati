import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_MAX_TOKEN_SIZE,
  TokenBudgetManager,
} from "../../src/context/budget/TokenBudgetManager.js";
import { countTokens } from "../../src/context/budget/tokenizer.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("TokenBudgetManager tiktoken estimator", () => {
  const m = new TokenBudgetManager();
  assert.equal(m.estimateTextTokens(""), 0);
  assert.equal(m.estimateTextTokens("abcd"), countTokens("abcd"));
  assert.equal(m.estimateTextTokens("a".repeat(40)), countTokens("a".repeat(40)));
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
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "a".repeat(100) }] },
  ];
  const tokens = countTokens("a".repeat(100)) + 4; // 13 + 4 = 17
  // ratio 17/200 = 0.085 → ok
  assert.equal(m.evaluate(messages, 200).state, "ok");
  // ratio 17/30 ≈ 0.57 → warning (>0.5)
  assert.equal(m.evaluate(messages, 30).state, "warning");
  // ratio 17/18 ≈ 0.94 → blocking (>0.9)
  assert.equal(m.evaluate(messages, 18).state, "blocking");
});

test("estimateTextTokens uses tiktoken (not char/4)", () => {
  const m = new TokenBudgetManager();
  // tiktoken o200k: "a".repeat(5) → 2 tokens (not 1 as char/4 would give)
  assert.equal(m.estimateTextTokens("a".repeat(5)), countTokens("a".repeat(5)));
  assert.equal(m.estimateTextTokens("a".repeat(7)), countTokens("a".repeat(7)));
  assert.equal(m.estimateTextTokens("a".repeat(10)), countTokens("a".repeat(10)));
});

test("CJK text gets accurate token count", () => {
  const m = new TokenBudgetManager();
  const cjk = "中文测试";
  const expected = countTokens(cjk);
  assert.equal(m.estimateTextTokens(cjk), expected);
  assert.ok(expected > 0, "CJK text should produce tokens");
});

test("estimateForFileType uses tiktoken regardless of ext", () => {
  const m = new TokenBudgetManager();
  const content = "a".repeat(100);
  const expected = countTokens(content);
  assert.equal(m.estimateForFileType(content, "json"), expected);
  assert.equal(m.estimateForFileType(content, "md"), expected);
  assert.equal(m.estimateForFileType("", "json"), 0);
});

test("thinking blocks count text only (signature ignored)", () => {
  const m = new TokenBudgetManager();
  const text = "a".repeat(40);
  const t = m.estimateForBlock({
    type: "thinking",
    text,
    signature: "long-signature-that-must-not-be-counted",
  });
  assert.equal(t, countTokens(text));
});

test("image / pdf / audio use IMAGE_MAX_TOKEN_SIZE", () => {
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

test("tool_call concatenates name + JSON.stringify(input)", () => {
  const m = new TokenBudgetManager();
  const serialized = "bash" + JSON.stringify({ command: "ls" });
  const t = m.estimateForBlock({
    type: "tool_call",
    id: "x",
    name: "bash",
    input: { command: "ls" },
  });
  assert.equal(t, countTokens(serialized));
});

test("tool_call with undefined / null input falls back to name only", () => {
  const m = new TokenBudgetManager();
  assert.equal(
    m.estimateForBlock({ type: "tool_call", id: "x", name: "abcd", input: null }),
    countTokens("abcd"),
  );
  assert.equal(
    m.estimateForBlock({ type: "tool_call", id: "x", name: "abcd", input: undefined }),
    countTokens("abcd"),
  );
});

test("tool_result recurses inner text blocks", () => {
  const m = new TokenBudgetManager();
  const t = m.estimateForBlock({
    type: "tool_result",
    toolCallId: "x",
    content: [
      { type: "text", text: "a".repeat(40) },
      { type: "text", text: "a".repeat(20) },
    ],
  });
  assert.equal(t, countTokens("a".repeat(40)) + countTokens("a".repeat(20)));
});

test("tool_result_reference uses preview only", () => {
  const m = new TokenBudgetManager();
  const preview = "a".repeat(40);
  const t = m.estimateForBlock({
    type: "tool_result_reference",
    toolCallId: "x",
    path: "/never-counted",
    originalBytes: 999_999_999,
    preview,
    hasMore: true,
  });
  assert.equal(t, countTokens(preview));
});

test("estimateForMessage adds perMessageOverhead", () => {
  const m = new TokenBudgetManager({ perMessageOverhead: 4 });
  const text = "a".repeat(40);
  const msg: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text }],
  };
  assert.equal(m.estimateForMessage(msg), countTokens(text) + 4);
});

test("estimateForMessagesWithPadding multiplies by 4/3 (ceil)", () => {
  const m = new TokenBudgetManager();
  const text = "a".repeat(120);
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text }] },
  ];
  const raw = countTokens(text) + 4; // 15 + 4 = 19
  const padded = Math.ceil((raw * 4) / 3);
  assert.equal(m.estimateForMessagesWithPadding(messages), padded);
  assert.equal(m.estimateForMessagesWithPadding([]), 0);
});
