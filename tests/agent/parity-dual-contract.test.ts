import test from "node:test";
import assert from "node:assert/strict";
import { agentContractScenarios } from "../fixtures/agent/dual-parity/contractScenarios.js";

test("agent dual contract manifest has unique ids and reasons for non-compare scenarios", () => {
  const ids = new Set<string>();
  for (const scenario of agentContractScenarios) {
    assert.equal(ids.has(scenario.id), false, `Duplicate agent contract scenario id ${scenario.id}.`);
    ids.add(scenario.id);
    if (scenario.status !== "compare") {
      assert.ok(scenario.reason, `${scenario.id} must explain non-compare status.`);
    }
  }
});

test("agent dual contract manifest covers implemented main-agent checkpoints", () => {
  const compareIds = new Set(agentContractScenarios.filter((scenario) => scenario.status === "compare").map((scenario) => scenario.id));

  assert.equal(compareIds.has("agent-no-tool-turn"), true);
  assert.equal(compareIds.has("agent-single-tool-continuation"), true);
  assert.equal(compareIds.has("agent-project-jsonl-resume"), true);
});
