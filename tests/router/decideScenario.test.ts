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
  background: { id: "primary/bg", provider: "primary", model: "bg" },
  longContext: { id: "primary/long", provider: "primary", model: "long" },
  longContextThreshold: 1_000,
  webSearch: { id: "primary/web", provider: "primary", model: "web" },
  think: { id: "primary/think", provider: "primary", model: "think" },
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

test("decideScenario picks background when request model contains haiku", () => {
  const result = decideScenario(
    {
      request: { ...baseRequest, model: "claude-haiku-3-5" },
      sessionId: "s1",
      isMainAgent: true,
    },
    scenarios,
  );
  assert.equal(result.scenarioType, "background");
  assert.equal(result.selection?.model, "bg");
});

test("decideScenario picks longContext when last usage exceeds threshold", () => {
  const result = decideScenario(
    {
      request: {
        ...baseRequest,
        messages: [
          { role: "user", content: [{ type: "text", text: "x".repeat(30_000) }] },
        ],
      },
      sessionId: "s1",
      isMainAgent: true,
      metadata: {
        lastUsage: { inputTokens: 5_000, totalTokens: 6_000 },
      },
    },
    scenarios,
  );
  assert.equal(result.scenarioType, "longContext");
  assert.equal(result.selection?.model, "long");
});

test("decideScenario picks think when request thinking is enabled", () => {
  const result = decideScenario(
    {
      request: { ...baseRequest, thinking: { enabled: true } },
      sessionId: "s1",
      isMainAgent: true,
    },
    scenarios,
  );
  assert.equal(result.scenarioType, "think");
  assert.equal(result.selection?.model, "think");
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
