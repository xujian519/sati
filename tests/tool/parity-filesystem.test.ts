import test from "node:test";
import {
  createEditFileTool,
  createGlobTool,
  createGrepTool,
  createReadFileTool,
  createWriteFileTool,
} from "../../src/tool/index.js";
import {
  filesystemEditWriteScenarios,
  filesystemReadScenarios,
  filesystemSearchScenarios,
} from "../fixtures/tool/legacy-behavior/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { assertScenarioResult } from "../helpers/parity.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("filesystem read parity scenarios match legacy gates", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({
    "src/a.txt": "one\ntwo",
    "bin.dat": Buffer.from([0, 1, 2]),
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  for (const scenario of filesystemReadScenarios.filter((item) => item.parity !== "deferred")) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.politdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});

test("filesystem search parity scenarios match legacy gates", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({
    "src/a.ts": "const value = 'needle';",
    "src/b.ts": "const value = 'hay';",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createGlobTool(), createGrepTool()],
    cwd: workspace.cwd,
  });

  for (const scenario of filesystemSearchScenarios.filter((item) => item.parity !== "deferred")) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.politdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});

test("filesystem edit and write parity scenarios match legacy gates", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({
    "edit.txt": "alpha",
    "existing.txt": "old",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createEditFileTool(), createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  for (const scenario of filesystemEditWriteScenarios.filter((item) => item.parity !== "deferred")) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.politdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});
