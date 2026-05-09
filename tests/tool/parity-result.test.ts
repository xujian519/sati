import test from "node:test";
import assert from "node:assert/strict";
import { createReadFileTool, createWriteFileTool, toCanonicalToolResultBlock } from "../../src/tool/index.js";
import { resultMappingScenarios } from "../fixtures/tool/legacy-behavior/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { assertScenarioResult } from "../helpers/parity.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("result mapping parity scenarios produce canonical tool_result blocks", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/a.txt": "one",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  for (const scenario of resultMappingScenarios) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.pilotdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
    const block = toCanonicalToolResultBlock(result);
    assert.equal(block.type, "tool_result");
    assert.equal(block.toolCallId, scenario.name);
    assert.equal(block.isError, result.type === "error" ? true : undefined);
  }
});
