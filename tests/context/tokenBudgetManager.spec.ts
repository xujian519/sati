import test from "node:test";
import assert from "node:assert/strict";
import { DefaultContextRuntime, effectiveInputContextTokens, TokenBudgetManager } from "../../src/context/index.js";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("effective input context subtracts output reservation", () => {
  assert.equal(effectiveInputContextTokens(1_000_000, 65_536), 934_464);
  assert.equal(effectiveInputContextTokens(262_144, 65_536), 196_608);
  assert.equal(effectiveInputContextTokens(65_536, 65_536), 1);
  assert.equal(effectiveInputContextTokens(65_536, 131_072), 1);
});

test("token budget ratio uses effective input context", () => {
  const budget = new TokenBudgetManager({ warningRatio: 0.5, blockingRatio: 0.9 });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "x".repeat(1000) }] },
  ];
  const tokens = budget.estimateMessagesTokens(messages);
  const snapshot = budget.evaluate(messages, tokens * 4, tokens * 2);
  assert.equal(snapshot.effectiveContextTokens, tokens * 2);
  assert.equal(snapshot.ratio, 0.5);
  assert.equal(snapshot.state, "warning");
});

test("token budget can use provider usage for pressure", () => {
  const budget = new TokenBudgetManager({ warningRatio: 0.5, blockingRatio: 0.9 });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "tiny" }] },
  ];
  const snapshot = budget.evaluate(messages, 1_000, 0, { inputTokens: 600, outputTokens: 50, totalTokens: 650 });
  assert.equal(snapshot.tokens, 650);
  assert.equal(snapshot.usageTokens, 650);
  assert.equal(snapshot.estimateSource, "usage");
  assert.equal(snapshot.state, "warning");
});

test("token budget never lets stale usage undercount current messages", () => {
  const budget = new TokenBudgetManager({ warningRatio: 0.5, blockingRatio: 0.9 });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "x".repeat(10_000) }] },
  ];
  const estimated = budget.estimateMessagesTokens(messages);
  const snapshot = budget.evaluate(messages, estimated * 2, 0, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  assert.equal(snapshot.tokens, estimated);
  assert.equal(snapshot.usageTokens, 2);
  assert.equal(snapshot.estimateSource, "usage");
});

test("post-compaction snapshots use compacted messages instead of stale usage", async () => {
  const budget = new TokenBudgetManager({ warningRatio: 0.5, blockingRatio: 0.9 });
  const compactedMessages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "ok" }] },
  ];
  const runtime = new DefaultContextRuntime({
    tokenBudget: budget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: budget }),
    maxContextTokens: 1_000,
    microCompaction: {
      apply: () => ({
        messages: compactedMessages,
        rewritten: 1,
        rewrittenBytes: 1,
        toolCallIds: ["call-1"],
        appliedTrigger: "time_based" as const,
      }),
    } as any,
  });
  const result = await runtime.tryAutoCompact({
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(10_000) }] }],
    lastUsage: { inputTokens: 10_000, outputTokens: 1, totalTokens: 10_001 },
  });
  assert.equal(result.type, "compacted");
  assert.equal(result.snapshot.estimateSource, "estimator");
  assert.equal(result.snapshot.state, "ok");
});

test("budget evaluator receives usage for initial pressure", async () => {
  const budget = new TokenBudgetManager({ warningRatio: 0.5, blockingRatio: 0.9 });
  const compactedMessages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "ok" }] },
  ];
  const runtime = new DefaultContextRuntime({
    tokenBudget: budget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: budget }),
    maxContextTokens: 1_000,
    microCompaction: {
      apply: () => ({
        messages: compactedMessages,
        rewritten: 1,
        rewrittenBytes: 1,
        toolCallIds: ["call-1"],
        appliedTrigger: "time_based" as const,
      }),
    } as any,
  });
  const result = await runtime.tryAutoCompact({
    messages: [{ role: "user", content: [{ type: "text", text: "tiny" }] }],
    lastUsage: { inputTokens: 950, outputTokens: 1, totalTokens: 951 },
    budgetEvaluator: async (candidate, lastUsage) => budget.evaluate(candidate, 1_000, {
      lastUsage,
    }),
  });
  assert.equal(result.type, "compacted");
  assert.equal(result.snapshot.state, "ok");
});
