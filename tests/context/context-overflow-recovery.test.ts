import test from "node:test";
import assert from "node:assert/strict";
import { ContextOverflowRecovery } from "../../src/context/recovery/ContextOverflowRecovery.js";
import type { CanonicalModelError } from "../../src/model/index.js";

const ptl: CanonicalModelError = {
  provider: "anthropic",
  protocol: "anthropic",
  code: "prompt_too_long",
  message: "Prompt is too long",
  retryable: false,
  recoverableViaCompact: true,
};

test("ContextOverflowRecovery first PTL → keepRatio 0.5", () => {
  const recovery = new ContextOverflowRecovery();
  const decision = recovery.decide({ error: ptl, hasAttemptedCompact: false });
  assert.equal(decision.type, "truncate_head_and_retry");
  if (decision.type === "truncate_head_and_retry") {
    assert.equal(decision.keepRatio, 0.5);
  }
});

test("ContextOverflowRecovery second PTL → give_up", () => {
  const recovery = new ContextOverflowRecovery();
  const decision = recovery.decide({ error: ptl, hasAttemptedCompact: true });
  assert.equal(decision.type, "give_up");
});

test("ContextOverflowRecovery non-PTL → give_up", () => {
  const recovery = new ContextOverflowRecovery();
  const decision = recovery.decide({
    error: { ...ptl, code: "auth_error", recoverableViaCompact: undefined },
    hasAttemptedCompact: false,
  });
  assert.equal(decision.type, "give_up");
});
