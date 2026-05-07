import test from "node:test";
import assert from "node:assert/strict";
import { agentExecutionScenarios } from "../fixtures/agent/dual-parity/executionScenarios.js";

test("agent dual execution manifest has unique ids and reasons for non-compare scenarios", () => {
  const ids = new Set<string>();
  for (const scenario of agentExecutionScenarios) {
    assert.equal(ids.has(scenario.id), false, `Duplicate agent execution scenario id ${scenario.id}.`);
    ids.add(scenario.id);
    if (scenario.status !== "compare") {
      assert.ok(scenario.reason, `${scenario.id} must explain non-compare status.`);
    }
  }
});

test("agent dual execution manifest covers implemented main-agent execution paths", () => {
  const compareIds = new Set(agentExecutionScenarios.filter((scenario) => scenario.status === "compare").map((scenario) => scenario.id));

  assert.equal(compareIds.has("agent-exec-no-tool-turn"), true);
  assert.equal(compareIds.has("agent-exec-tool-continuation"), true);
  assert.equal(compareIds.has("agent-exec-project-resume"), true);
  assert.equal(compareIds.has("agent-exec-fallback-model"), true);
});
