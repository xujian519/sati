import { utimes } from "node:fs/promises";
import path from "node:path";
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
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { assertScenarioResult } from "../helpers/parity.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("filesystem read parity scenarios match legacy gates", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/a.txt": "one\ntwo",
    "bin.dat": Buffer.from([0, 1, 2]),
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  for (const scenario of filesystemReadScenarios.filter((item) => item.parity !== "deferred")) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.pilotdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});

test("filesystem search parity scenarios match legacy gates", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/a.ts": "const value = 'needle';",
    "src/b.ts": "const value = 'hay';",
    "src/c.ts": "const value = 'needle';",
  });
  t.after(() => workspace.cleanup());
  const now = new Date();
  await utimes(
    path.join(workspace.cwd, "src/a.ts"),
    new Date(now.getTime() - 60_000),
    new Date(now.getTime() - 60_000),
  );
  await utimes(path.join(workspace.cwd, "src/c.ts"), now, now);
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGlobTool(), createGrepTool()],
    cwd: workspace.cwd,
  });

  for (const scenario of filesystemSearchScenarios.filter((item) => item.parity !== "deferred")) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.pilotdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});

test("filesystem edit and write parity scenarios match legacy gates", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "edit.txt": "alpha",
    "existing.txt": "old",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createEditFileTool(), createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  for (const scenario of filesystemEditWriteScenarios.filter((item) => item.parity !== "deferred")) {
    const result = await toolRuntime.execute(
      { id: scenario.name, name: scenario.pilotdeckToolName, input: scenario.input },
      context,
    );
    assertScenarioResult(scenario, result);
  }
});
