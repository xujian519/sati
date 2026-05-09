import test from "node:test";
import assert from "node:assert/strict";
import { createGlobTool } from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("glob matches files with stable sorted results and limit", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/b.ts": "b",
    "src/a.ts": "a",
    "src/c.js": "c",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGlobTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "glob", input: { pattern: "**/*.ts", limit: 1 } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, { files: ["src/a.ts"], count: 2, truncated: true });
});

test("glob denies path outside workspace", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGlobTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "glob", input: { pattern: "**/*", path: "../" } },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "path_not_allowed");
});
