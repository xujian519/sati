import test from "node:test";
import assert from "node:assert/strict";
import { createReadFileTool } from "../../src/tool/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("read_file reads text files with offset and limit", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({ "src/a.txt": "one\ntwo\nthree\nfour" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { filePath: "src/a.txt", offset: 1, limit: 2 } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "two\nthree");
  assert.equal(result.metadata?.truncated, true);
});

test("read_file returns controlled errors for missing and outside paths", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const missing = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { filePath: "missing.txt" } },
    context,
  );
  const outside = await toolRuntime.execute(
    { id: "call-2", name: "read_file", input: { filePath: "../outside.txt" } },
    context,
  );

  assert.equal(missing.type, "error");
  assert.equal(outside.type, "error");
  if (missing.type === "error") assert.equal(missing.error.code, "file_not_found");
  if (outside.type === "error") assert.equal(outside.error.code, "path_not_allowed");
});
