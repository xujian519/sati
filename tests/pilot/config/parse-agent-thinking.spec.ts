import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentThinking } from "../../../src/pilot/config/loadPilotConfig.js";

test("parseAgentThinking returns undefined when absent or null", () => {
  assert.equal(parseAgentThinking(undefined), undefined);
  assert.equal(parseAgentThinking(null), undefined);
});

test("parseAgentThinking returns undefined when enabled is not a boolean", () => {
  assert.equal(parseAgentThinking({}), undefined);
  assert.equal(parseAgentThinking({ enabled: "yes" }), undefined);
  assert.equal(parseAgentThinking(42), undefined);
});

test("parseAgentThinking honors enabled:true with optional budgetTokens", () => {
  assert.deepEqual(parseAgentThinking({ enabled: true }), { enabled: true });
  assert.deepEqual(parseAgentThinking({ enabled: true, budgetTokens: 8192 }), {
    enabled: true,
    budgetTokens: 8192,
  });
});

test("parseAgentThinking preserves explicit enabled:false (distinct from unset)", () => {
  assert.deepEqual(parseAgentThinking({ enabled: false }), { enabled: false });
});
