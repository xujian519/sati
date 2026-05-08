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
    ["agent", "bash", "edit_file", "glob", "grep", "read_file", "web_search", "write_file"],
  );
  assert.equal(registry.get("Read")?.name, "read_file");
  assert.equal(registry.get("Bash")?.name, "bash");
  assert.equal(registry.get("WebSearch")?.name, "web_search");
  assert.equal(registry.get("Agent")?.name, "agent");
  assert.equal(registry.get("Task")?.name, "agent");
});

test("createBuiltinRegistry can opt out of web_search", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    webSearch: false,
  });
  assert.equal(registry.has("web_search"), false);
});

test("createBuiltinRegistry can opt out of agent", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    agent: false,
  });
  assert.equal(registry.has("agent"), false);
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
