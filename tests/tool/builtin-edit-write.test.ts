import test from "node:test";
import assert from "node:assert/strict";
import { createEditFileTool, createWriteFileTool } from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("edit_file replaces one exact occurrence and replace_all replaces all", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "a.txt": "one two one" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createEditFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  const ambiguous = await toolRuntime.execute(
    { id: "call-1", name: "edit_file", input: { file_path: "a.txt", old_string: "one", new_string: "1" } },
    context,
  );
  assert.equal(ambiguous.type, "error");
  if (ambiguous.type === "error") assert.equal(ambiguous.error.code, "invalid_tool_input");

  const result = await toolRuntime.execute(
    {
      id: "call-2",
      name: "edit_file",
      input: { file_path: "a.txt", old_string: "one", new_string: "1", replace_all: true },
    },
    context,
  );
  assert.equal(result.type, "success");
  assert.equal(await workspace.read("a.txt"), "1 two 1");
});

test("write_file creates files and denies overwrite without explicit flag", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "existing.txt": "old" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  const created = await toolRuntime.execute(
    { id: "call-1", name: "write_file", input: { file_path: "new.txt", content: "new" } },
    context,
  );
  const denied = await toolRuntime.execute(
    { id: "call-2", name: "write_file", input: { file_path: "existing.txt", content: "new" } },
    context,
  );
  const overwritten = await toolRuntime.execute(
    {
      id: "call-3",
      name: "write_file",
      input: { file_path: "existing.txt", content: "new", allow_overwrite: true },
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
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "plan",
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "write_file", input: { file_path: "new.txt", content: "new" } },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});
