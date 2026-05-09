import test from "node:test";
import assert from "node:assert/strict";
import { WEB_UI_PARITY_SCENARIOS } from "../fixtures/web-ui/parity-scenarios.js";

test("WEB_UI_PARITY_SCENARIOS has unique scenario ids", () => {
  const ids = new Set<string>();
  for (const scenario of WEB_UI_PARITY_SCENARIOS) {
    assert.ok(!ids.has(scenario.scenarioId), `duplicate scenarioId: ${scenario.scenarioId}`);
    ids.add(scenario.scenarioId);
  }
});

test("non-compare scenarios must include a reason", () => {
  for (const scenario of WEB_UI_PARITY_SCENARIOS) {
    if (scenario.status === "compare") {
      continue;
    }
    assert.ok(
      typeof scenario.reason === "string" && scenario.reason.trim().length > 0,
      `${scenario.scenarioId} (${scenario.status}) is missing a reason`,
    );
  }
});

test("scenario phase is in range 0..5", () => {
  for (const scenario of WEB_UI_PARITY_SCENARIOS) {
    assert.ok(
      scenario.phase >= 0 && scenario.phase <= 5,
      `${scenario.scenarioId} has out-of-range phase: ${scenario.phase}`,
    );
  }
});

test("phase 1 + 2 contain at least the chat-essential scenarios", () => {
  const required = [
    "session-list-basic",
    "session-history-text-only",
    "submit-turn-text-stream",
    "submit-turn-tool-call",
    "abort-turn",
    "permission-request-allow",
    "permission-request-deny",
  ];
  for (const id of required) {
    const scenario = WEB_UI_PARITY_SCENARIOS.find((s) => s.scenarioId === id);
    assert.ok(scenario, `missing required parity scenario: ${id}`);
    assert.equal(scenario?.status, "compare", `${id} must be 'compare'`);
  }
});
