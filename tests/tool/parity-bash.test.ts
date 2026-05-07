import test from "node:test";
import { createBashTool, type PolitDeckCommandOptions, type PolitDeckCommandResult, type PolitDeckCommandRunner } from "../../src/tool/index.js";
import { bashExecutionScenarios } from "../fixtures/tool/legacy-behavior/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { assertDeferredScenarios, assertScenarioResult } from "../helpers/parity.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

class ScenarioRunner implements PolitDeckCommandRunner {
  async run(command: string, _options: PolitDeckCommandOptions): Promise<PolitDeckCommandResult> {
    if (command.includes("exit 2")) {
      return { exitCode: 2, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
    }
    return { exitCode: 0, stdout: "/workspace\n", stderr: "", timedOut: false, durationMs: 1 };
  }
}

test("bash parity scenarios match legacy gates", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  assertDeferredScenarios(bashExecutionScenarios);
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createBashTool({ runner: new ScenarioRunner() })],
    cwd: workspace.cwd,
  });

  for (const scenario of bashExecutionScenarios.filter((item) => item.parity !== "deferred")) {
    context.permissionContext.mode = scenario.permissionMode;
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.politdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});
