import test from "node:test";
import assert from "node:assert/strict";
import { isFallbackEligible, planFallback } from "../../src/router/fallback/runFallbackChain.js";

test("planFallback returns scenario-specific list when present", () => {
  const plan = planFallback(
    {
      default: [{ id: "a/m", provider: "a", model: "m" }],
      longContext: [{ id: "b/m", provider: "b", model: "m" }],
    },
    "longContext",
  );
  assert.equal(plan.attempts.length, 1);
  assert.equal(plan.attempts[0]?.provider, "b");
});

test("planFallback falls back to default list when scenario list is missing", () => {
  const plan = planFallback(
    { default: [{ id: "a/m", provider: "a", model: "m" }] },
    "longContext",
  );
  assert.equal(plan.attempts.length, 1);
  assert.equal(plan.attempts[0]?.provider, "a");
});

test("isFallbackEligible refuses prompt-too-long and non-retryable errors", () => {
  assert.equal(
    isFallbackEligible({
      provider: "p",
      protocol: "anthropic",
      code: "prompt_too_long",
      message: "too long",
      retryable: false,
    }),
    false,
  );
  assert.equal(
    isFallbackEligible({
      provider: "p",
      protocol: "anthropic",
      code: "auth_error",
      message: "no",
      retryable: false,
    }),
    false,
  );
  assert.equal(
    isFallbackEligible({
      provider: "p",
      protocol: "anthropic",
      code: "overloaded_error",
      message: "retry me",
      retryable: true,
    }),
    true,
  );
});
