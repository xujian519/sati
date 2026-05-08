import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleHookPluginContractScenarios } from "../fixtures/lifecycle-hooks-plugins/dual-parity/contractScenarios.js";
import { lifecycleHookPluginExecutionScenarios } from "../fixtures/lifecycle-hooks-plugins/dual-parity/executionScenarios.js";
import { createLifecycleHookPluginContractReport } from "../helpers/lifecycleHooksPluginContractReport.js";
import { createLifecycleHookPluginExecutionReport } from "../helpers/lifecycleHooksPluginExecutionReport.js";

test("lifecycle/hooks/plugin parity manifests have unique ids and non-compare reasons", () => {
  assertManifest(lifecycleHookPluginContractScenarios);
  assertManifest(lifecycleHookPluginExecutionScenarios);
});

test("lifecycle/hooks/plugin reports mirror scenario statuses without claiming execution parity", () => {
  assert.deepEqual(
    createLifecycleHookPluginContractReport().map(({ id, status }) => ({ id, status })),
    lifecycleHookPluginContractScenarios.map(({ id, status }) => ({ id, status })),
  );
  assert.deepEqual(
    createLifecycleHookPluginExecutionReport().map(({ id, status }) => ({ id, status })),
    lifecycleHookPluginExecutionScenarios.map(({ id, status }) => ({ id, status })),
  );
});

function assertManifest(scenarios: Array<{ id: string; status: string; reason?: string }>): void {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    assert.equal(ids.has(scenario.id), false, `Duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    if (scenario.status !== "compare") {
      assert.ok(scenario.reason, `${scenario.id} must document why it is not compared.`);
    }
  }
}
