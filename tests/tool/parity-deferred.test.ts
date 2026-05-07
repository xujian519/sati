import test from "node:test";
import assert from "node:assert/strict";
import { deferredToolScenarios, intentionalDifferences } from "../fixtures/tool/legacy-behavior/index.js";
import { assertDeferredScenarios } from "../helpers/parity.js";

test("deferred parity scenarios are explicitly assigned to future phases", () => {
  assertDeferredScenarios(deferredToolScenarios);
  assert.ok(deferredToolScenarios.length > 0);
});

test("intentional differences are registered with release risk metadata", () => {
  assert.ok(intentionalDifferences.length > 0);
  for (const difference of intentionalDifferences) {
    assert.ok(difference.id);
    assert.ok(difference.legacyBehavior);
    assert.ok(difference.politdeckBehavior);
    assert.ok(difference.reason);
    if (difference.risk === "higher") {
      assert.equal(difference.reviewRequiredBeforeRelease, true);
    }
  }
});
