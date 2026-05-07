import test from "node:test";
import assert from "node:assert/strict";
import { createBuiltinRegistry } from "../../src/tool/index.js";
import { registryScenarios } from "../fixtures/tool/legacy-behavior/index.js";

test("registry parity scenarios preserve legacy aliases", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
  });

  for (const scenario of registryScenarios) {
    const alias = (scenario.input as { alias: string }).alias;
    assert.equal(registry.get(alias)?.name, scenario.politdeckToolName, scenario.name);
  }
});
