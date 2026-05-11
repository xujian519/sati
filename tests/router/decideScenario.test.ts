import test from "node:test";
import assert from "node:assert/strict";
import { decideScenario } from "../../src/router/scenario/decideScenario.js";
import type { CanonicalModelRequest } from "../../src/model/index.js";
import type { RouterScenariosConfig } from "../../src/router/config/schema.js";

const baseRequest: CanonicalModelRequest = {
  provider: "test",
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

const scenarios: RouterScenariosConfig = {
  default: { id: "primary/main", provider: "primary", model: "main" },
};

test("decideScenario returns default scenario when nothing else matches", () => {
  const result = decideScenario(
    { request: baseRequest, sessionId: "s1", isMainAgent: true },
    scenarios,
  );
  assert.equal(result.scenarioType, "default");
  assert.equal(result.selection?.model, "main");
  assert.equal(result.isSubagent, false);
});

test("decideScenario flags subagent when caller marks isMainAgent=false", () => {
  const result = decideScenario(
    { request: baseRequest, sessionId: "s1", isMainAgent: false },
    scenarios,
  );
  assert.equal(result.isSubagent, true);
});

test("decideScenario detects subagent tag and extracts model hint", () => {
  const result = decideScenario(
    {
      request: {
        ...baseRequest,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "<pilotdeck-subagent-model>vendor/sub-x</pilotdeck-subagent-model>",
              },
            ],
          },
        ],
      },
      sessionId: "s1",
      isMainAgent: true,
    },
    scenarios,
  );
  assert.equal(result.isSubagent, true);
  assert.equal(result.subagentModelHint, "vendor/sub-x");
  assert.equal(result.scenarioType, "subagent");
});

test("decideScenario honours explicit overrides via metadata", () => {
  const result = decideScenario(
    {
      request: baseRequest,
      sessionId: "s1",
      isMainAgent: true,
      metadata: { explicitProvider: "anthropic", explicitModel: "claude" },
    },
    scenarios,
  );
  assert.equal(result.scenarioType, "explicit");
  assert.equal(result.selection?.provider, "anthropic");
  assert.equal(result.selection?.model, "claude");
});
