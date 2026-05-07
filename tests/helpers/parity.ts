import assert from "node:assert/strict";
import type { PermissionDecision } from "../../src/permission/index.js";
import type { PolitDeckToolResult } from "../../src/tool/index.js";
import { contentToText } from "../../src/tool/index.js";
import type { PolitDeckToolBehaviorScenario } from "../fixtures/tool/legacy-behavior/index.js";

export function assertScenarioResult(scenario: PolitDeckToolBehaviorScenario, result: PolitDeckToolResult): void {
  assert.notEqual(scenario.parity, "deferred", `${scenario.name} is deferred and should not be executed.`);
  assert.notEqual(scenario.parity, "not_applicable", `${scenario.name} is not applicable and should not be executed.`);

  if (scenario.expectedResultType) {
    assert.equal(result.type, scenario.expectedResultType, scenario.name);
  }

  if (scenario.expectedErrorCode) {
    assert.equal(result.type, "error", scenario.name);
    if (result.type === "error") {
      assert.equal(result.error.code, scenario.expectedErrorCode, scenario.name);
    }
  }

  for (const expected of scenario.expectedContentIncludes ?? []) {
    const text = result.content.map(contentToText).join("\n");
    assert.match(text, new RegExp(escapeRegExp(expected)), scenario.name);
  }

  if (scenario.expectedData && result.type === "success") {
    for (const [key, value] of Object.entries(scenario.expectedData as Record<string, unknown>)) {
      assert.equal((result.data as Record<string, unknown> | undefined)?.[key], value, scenario.name);
    }
  }
}

export function assertScenarioDecision(scenario: PolitDeckToolBehaviorScenario, decision: PermissionDecision): void {
  if (scenario.expectedDecision) {
    assert.equal(decision.type, scenario.expectedDecision, scenario.name);
  }
}

export function assertDeferredScenarios(scenarios: PolitDeckToolBehaviorScenario[]): void {
  for (const scenario of scenarios) {
    if (scenario.parity === "deferred") {
      assert.ok(scenario.deferredUntil, `${scenario.name} must declare deferredUntil.`);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}
