import test from "node:test";
import assert from "node:assert/strict";
import { createEditFileTool, createWriteFileTool } from "../../src/tool/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("edit_file replaces one exact occurrence and replaceAll replaces all", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({ "a.txt": "one two one" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createEditFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  const ambiguous = await toolRuntime.execute(
    { id: "call-1", name: "edit_file", input: { filePath: "a.txt", oldString: "one", newString: "1" } },
    context,
  );
  assert.equal(ambiguous.type, "error");
  if (ambiguous.type === "error") assert.equal(ambiguous.error.code, "invalid_tool_input");

  const result = await toolRuntime.execute(
    {
      id: "call-2",
      name: "edit_file",
      input: { filePath: "a.txt", oldString: "one", newString: "1", replaceAll: true },
    },
    context,
  );
  assert.equal(result.type, "success");
  assert.equal(await workspace.read("a.txt"), "1 two 1");
});

test("write_file creates files and denies overwrite without explicit flag", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({ "existing.txt": "old" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  const created = await toolRuntime.execute(
    { id: "call-1", name: "write_file", input: { filePath: "new.txt", content: "new" } },
    context,
  );
  const denied = await toolRuntime.execute(
    { id: "call-2", name: "write_file", input: { filePath: "existing.txt", content: "new" } },
    context,
  );
  const overwritten = await toolRuntime.execute(
    {
      id: "call-3",
      name: "write_file",
      input: { filePath: "existing.txt", content: "new", allowOverwrite: true },
    },
    context,
  );

  assert.equal(created.type, "success");
  assert.equal(denied.type, "error");
  if (denied.type === "error") assert.equal(denied.error.code, "file_conflict");
  assert.equal(overwritten.type, "success");
  assert.equal(await workspace.read("existing.txt"), "new");
});

test("write tools are denied in plan mode before execution", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "plan",
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "write_file", input: { filePath: "new.txt", content: "new" } },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});
