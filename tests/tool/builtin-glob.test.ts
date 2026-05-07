import test from "node:test";
import assert from "node:assert/strict";
import { createGlobTool } from "../../src/tool/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("glob matches files with stable sorted results and limit", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({
    "src/b.ts": "b",
    "src/a.ts": "a",
    "src/c.js": "c",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
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
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
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
