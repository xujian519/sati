import test from "node:test";
import assert from "node:assert/strict";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { countTokens } from "../../src/context/budget/tokenizer.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const policy = new AutoCompactionPolicy({
  tokenBudget: new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.95 }),
});

function bigMessage(chars: number): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text: "a".repeat(chars) }] };
}

test("AutoCompactionPolicy.skip when below 80%", () => {
  // "a" x 40 → 5 tokens + 4 overhead = 9; 9 / 1000 = 0.009 → ok
  const decision = policy.evaluate([bigMessage(40)], 1_000);
  assert.equal(decision.type, "skip");
});

test("AutoCompactionPolicy.trigger warning when ratio in [0.8, 0.95)", () => {
  // "a" x 620 → 78 tokens + 4 overhead = 82; 82/100 = 0.82 → warning
  const decision = policy.evaluate([bigMessage(620)], 100);
  assert.equal(decision.type, "trigger");
  if (decision.type === "trigger") {
    assert.equal(decision.reason, "warning_threshold");
  }
});

test("AutoCompactionPolicy.trigger blocking when ratio >= 0.95", () => {
  // "a" x 730 → 92 tokens + 4 overhead = 96; 96/100 = 0.96 → blocking
  const decision = policy.evaluate([bigMessage(730)], 100);
  assert.equal(decision.type, "trigger");
  if (decision.type === "trigger") {
    assert.equal(decision.reason, "blocking_threshold");
  }
});
