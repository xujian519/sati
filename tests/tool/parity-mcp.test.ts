import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpToolWireName, createMcpTool } from "../../src/tool/index.js";
import { mcpScenarios } from "../fixtures/tool/legacy-behavior/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { assertDeferredScenarios, assertScenarioResult } from "../helpers/parity.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("mcp parity scenarios preserve wire name and unsupported behavior", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  assertDeferredScenarios(mcpScenarios);
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createMcpTool({ serverId: "my-server", toolName: "read thing" })],
    cwd: workspace.cwd,
  });

  assert.equal(buildMcpToolWireName("my-server", "read thing"), "mcp__my_server__read_thing");

  for (const scenario of mcpScenarios.filter((item) => item.parity !== "deferred")) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.pilotdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});
