import test from "node:test";
import assert from "node:assert/strict";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const policy = new AutoCompactionPolicy({
  tokenBudget: new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.95 }),
});

function bigMessage(chars: number): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text: "a".repeat(chars) }] };
}

test("AutoCompactionPolicy.skip when below 80%", () => {
  // 40 chars → 10 tokens + 4 overhead = 14; 14 / 1000 = 1.4% → ok
  const decision = policy.evaluate([bigMessage(40)], 1_000);
  assert.equal(decision.type, "skip");
});

test("AutoCompactionPolicy.trigger warning when ratio in [0.8, 0.95)", () => {
  // 320 chars → 80 + 4 = 84; ratio 84/100 = 0.84 → warning
  const decision = policy.evaluate([bigMessage(320)], 100);
  assert.equal(decision.type, "trigger");
  if (decision.type === "trigger") {
    assert.equal(decision.reason, "warning_threshold");
  }
});

test("AutoCompactionPolicy.trigger blocking when ratio >= 0.95", () => {
  // 400 chars → 100 + 4 = 104; ratio 104/100 = 1.04 → blocking
  const decision = policy.evaluate([bigMessage(400)], 100);
  assert.equal(decision.type, "trigger");
  if (decision.type === "trigger") {
    assert.equal(decision.reason, "blocking_threshold");
  }
});
