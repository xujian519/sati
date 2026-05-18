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
    [
      "agent",
      "ask_user_question",
      "bash",
      "edit_file",
      "edit_notebook",
      "enter_plan_mode",
      "exit_plan_mode",
      "glob",
      "grep",
      "read_file",
      "structured_output",
      "web_fetch",
      "web_search",
      "write_file",
    ],
  );
  assert.equal(registry.get("Read")?.name, "read_file");
  assert.equal(registry.get("Bash")?.name, "bash");
  assert.equal(registry.get("NotebookEdit")?.name, "edit_notebook");
  assert.equal(registry.get("WebSearch")?.name, "web_search");
  assert.equal(registry.get("WebFetch")?.name, "web_fetch");
  assert.equal(registry.get("Agent")?.name, "agent");
  assert.equal(registry.get("Task")?.name, "agent");
  assert.equal(registry.get("StructuredOutput")?.name, "structured_output");
  assert.equal(registry.get("AskUserQuestion")?.name, "ask_user_question");
  assert.equal(registry.get("EnterPlanMode")?.name, "enter_plan_mode");
  assert.equal(registry.get("ExitPlanMode")?.name, "exit_plan_mode");
});

test("createBuiltinRegistry can opt out of structured_output", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    structuredOutput: false,
  });
  assert.equal(registry.has("structured_output"), false);
});

test("createBuiltinRegistry can opt out of ask_user_question", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    askUserQuestion: false,
  });
  assert.equal(registry.has("ask_user_question"), false);
});

test("createBuiltinRegistry can opt out of web_fetch", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    webFetch: false,
  });
  assert.equal(registry.has("web_fetch"), false);
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

test("createBuiltinRegistry can opt out of planMode", () => {
  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    planMode: false,
  });
  assert.equal(registry.has("enter_plan_mode"), false);
  assert.equal(registry.has("exit_plan_mode"), false);
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
    .map((scenario) => scenario.pilotdeck.toolName);

  assert.ok(deferredToolNames.length > 0);
  for (const toolName of deferredToolNames) {
    assert.equal(registry.has(toolName), false, `${toolName} should remain deferred and absent from builtin registry.`);
  }
});
