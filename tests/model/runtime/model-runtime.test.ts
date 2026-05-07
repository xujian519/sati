import test from "node:test";
import assert from "node:assert/strict";
import { createModelRuntime, parseModelConfig } from "../../../src/model/index.js";
import { validModelConfig } from "../helpers.js";

test("creates a config-bound ModelRuntime with stable integration methods", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const runtime = createModelRuntime(config);

  const capabilities = runtime.getCapabilities("anthropic-main", "claude-sonnet-4-5");

  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
  assert.equal(capabilities.supportsThinking, true);
  assert.equal(capabilities.maxContextTokens, 200000);
});
