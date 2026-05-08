import test from "node:test";
import assert from "node:assert/strict";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
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
