import test from "node:test";
import assert from "node:assert/strict";
import { createBuiltinRegistry } from "../../src/tool/index.js";
import { dualParityContractScenarios } from "../fixtures/tool/dual-parity/contractScenarios.js";

test("creates a builtin registry with first implementation tools", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
  });

  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ["bash", "edit_file", "glob", "grep", "read_file", "write_file"],
  );
  assert.equal(registry.get("Read")?.name, "read_file");
  assert.equal(registry.get("Bash")?.name, "bash");
});

test("deferred tool features are not exposed by the first-phase builtin registry", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
  });
  const deferredToolNames = dualParityContractScenarios
    .filter((scenario) => scenario.status === "deferred")
    .map((scenario) => scenario.politdeck.toolName);

  assert.ok(deferredToolNames.length > 0);
  for (const toolName of deferredToolNames) {
    assert.equal(registry.has(toolName), false, `${toolName} should remain deferred and absent from builtin registry.`);
  }
});
