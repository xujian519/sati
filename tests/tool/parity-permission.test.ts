import test from "node:test";
import { PermissionRuntime } from "../../src/permission/index.js";
import { createBashTool, createEditFileTool, createReadFileTool, createWriteFileTool } from "../../src/tool/index.js";
import { permissionModeScenarios } from "../fixtures/tool/legacy-behavior/index.js";
import { assertScenarioDecision } from "../helpers/parity.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("permission mode parity scenarios match legacy behavior gates", async () => {
  const tools = [createReadFileTool(), createWriteFileTool(), createEditFileTool(), createBashTool()];
  const runtime = new PermissionRuntime();

  for (const scenario of permissionModeScenarios.filter((item) => item.parity === "must_match")) {
    const tool = tools.find((candidate) => candidate.name === scenario.politdeckToolName);
    if (!tool) throw new Error(`Missing tool ${scenario.politdeckToolName}`);
    const { context } = createPolitDeckToolRuntimeFixture({
      tools,
      permissionMode: scenario.permissionMode,
      canPrompt: true,
    });
    const decision = await runtime.decide(tool, scenario.input, context, "call-1");
    assertScenarioDecision(scenario, decision);
  }
});
