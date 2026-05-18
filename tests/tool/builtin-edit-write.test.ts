import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
  type WriteFileOutput,
} from "../../src/tool/index.js";
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

test("write_file accepts relative paths and overwrites only after full read", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "existing.txt": "old" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });
  const newFilePath = path.join(workspace.cwd, "new.txt");
  const existingPath = path.join(workspace.cwd, "existing.txt");

  const createdFromRelative = await toolRuntime.execute(
    { id: "call-0", name: "write_file", input: { file_path: "new.txt", content: "new" } },
    context,
  );
  const updatedFromAbsolute = await toolRuntime.execute(
    { id: "call-1", name: "write_file", input: { file_path: newFilePath, content: "new" } },
    context,
  );
  const unread = await toolRuntime.execute(
    { id: "call-2", name: "write_file", input: { file_path: "existing.txt", content: "new" } },
    context,
  );
  const partialRead = await toolRuntime.execute(
    { id: "call-3", name: "read_file", input: { file_path: "existing.txt", offset: 1, limit: 1 } },
    context,
  );
  const afterPartialRead = await toolRuntime.execute(
    { id: "call-4", name: "write_file", input: { file_path: "existing.txt", content: "new" } },
    context,
  );
  const fullRead = await toolRuntime.execute(
    { id: "call-5", name: "read_file", input: { file_path: "existing.txt" } },
    context,
  );
  const overwritten = await toolRuntime.execute(
    { id: "call-6", name: "write_file", input: { file_path: "existing.txt", content: "new" } },
    context,
  );
  const outside = await toolRuntime.execute(
    { id: "call-7", name: "write_file", input: { file_path: "../outside.txt", content: "bad" } },
    context,
  );

  assert.equal(createdFromRelative.type, "success");
  assert.equal(updatedFromAbsolute.type, "success");
  assert.equal(unread.type, "error");
  assert.equal(partialRead.type, "success");
  assert.equal(afterPartialRead.type, "error");
  assert.equal(fullRead.type, "success");
  assert.equal(overwritten.type, "success");
  assert.equal(outside.type, "error");
  assert.equal(await workspace.read("new.txt"), "new");
  assert.equal(await workspace.read("existing.txt"), "new");
  if (unread.type === "error") assert.equal(unread.error.code, "invalid_tool_input");
  if (afterPartialRead.type === "error") assert.equal(afterPartialRead.error.code, "invalid_tool_input");
  if (outside.type === "error") assert.equal(outside.error.code, "invalid_tool_input");
  if (createdFromRelative.type === "success") {
    const data = createdFromRelative.data as WriteFileOutput | undefined;
    assert.equal(data?.filePath, newFilePath);
    assert.equal(data?.type, "create");
    assert.equal(data?.originalFile, null);
    assert.ok(Array.isArray(data?.structuredPatch));
  }
  if (updatedFromAbsolute.type === "success") {
    const data = updatedFromAbsolute.data as WriteFileOutput | undefined;
    assert.equal(data?.filePath, newFilePath);
    assert.equal(data?.type, "update");
    assert.equal(data?.originalFile, "new");
  }
  if (overwritten.type === "success") {
    const data = overwritten.data as WriteFileOutput | undefined;
    assert.equal(data?.type, "update");
    assert.equal(data?.filePath, existingPath);
    assert.equal(data?.originalFile, "old");
    assert.equal(data?.content, "new");
    assert.ok(Array.isArray(data?.structuredPatch));
    assert.equal(data?.gitDiff?.path, "existing.txt");
  }
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
    { id: "call-1", name: "write_file", input: { file_path: path.join(workspace.cwd, "new.txt"), content: "new" } },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});

test("write_file rejects stale writes, updates write snapshots, and notifies file updates", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "existing.txt": "old" });
  t.after(() => workspace.cleanup());
  const notifications: string[] = [];
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
    fileUpdateNotifier: {
      didChange(update) {
        notifications.push(`change:${update.relativePath}:${update.content}`);
      },
      didSave(update) {
        notifications.push(`save:${update.relativePath}:${update.content}`);
      },
    },
  });
  const existingPath = path.join(workspace.cwd, "existing.txt");

  const read = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "existing.txt" } },
    context,
  );
  await waitForFreshMtimeTick();
  await workspace.write("existing.txt", "user change");
  const stale = await toolRuntime.execute(
    { id: "call-2", name: "write_file", input: { file_path: "existing.txt", content: "agent change" } },
    context,
  );

  assert.equal(read.type, "success");
  assert.equal(stale.type, "error");
  if (stale.type === "error") {
    assert.equal(stale.error.code, "invalid_tool_input");
  }

  await waitForFreshMtimeTick();
  const reread = await toolRuntime.execute(
    { id: "call-3", name: "read_file", input: { file_path: "existing.txt" } },
    context,
  );
  const success = await toolRuntime.execute(
    { id: "call-4", name: "write_file", input: { file_path: "existing.txt", content: "agent change" } },
    context,
  );

  assert.equal(reread.type, "success");
  assert.equal(success.type, "success");
  assert.equal(await workspace.read("existing.txt"), "agent change");
  assert.deepEqual(notifications, [
    "change:existing.txt:agent change",
    "save:existing.txt:agent change",
  ]);
  assert.equal(context.writeSnapshots?.get(existingPath)?.absolutePath, existingPath);
});

async function waitForFreshMtimeTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
