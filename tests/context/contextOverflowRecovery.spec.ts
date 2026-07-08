import test from "node:test";
import assert from "node:assert/strict";
import { ContextOverflowRecovery } from "../../src/context/index.js";
import type { CanonicalModelError } from "../../src/model/index.js";

function error(overrides: Partial<CanonicalModelError>): CanonicalModelError {
  return {
    provider: "test",
    protocol: "openai",
    code: "context_overflow",
    message: "boom",
    retryable: false,
    ...overrides,
  };
}

test("output cap errors retry with adjusted output without compacting", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({ error: error({ code: "invalid_request", maxOutputTokens: 32768 }), hasAttemptedCompact: false }),
    { type: "adjust_output_and_retry", maxOutputTokens: 32768, reason: "provider-output-cap" },
  );
});

test("context cap errors request compaction against provider cap", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({ error: error({ maxContextTokens: 262144, recoverableViaCompact: true }), hasAttemptedCompact: false }),
    { type: "compact_and_retry", maxContextTokens: 262144, reason: "provider-context-cap" },
  );
});
