import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  contentToText,
  createEditFileTool,
  createEditNotebookTool,
  createReadFileTool,
  createWriteFileTool,
  type EditNotebookOutput,
} from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("edit_notebook replaces a code cell, clears outputs, and refreshes snapshots", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "nb.ipynb": notebookFixture({
      cells: [
        codeCell("cell-a", "print('old')\n", {
          execution_count: 7,
          outputs: [{ output_type: "stream", text: "old\n" }],
        }),
      ],
    }),
  });
  t.after(() => workspace.cleanup());
  const notifications: string[] = [];
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createEditNotebookTool(), createWriteFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
    fileUpdateNotifier: {
      didChange(update) {
        notifications.push(`change:${update.relativePath}`);
      },
      didSave(update) {
        notifications.push(`save:${update.relativePath}`);
      },
    },
  });
  const notebookPath = path.join(workspace.cwd, "nb.ipynb");

  const read = await toolRuntime.execute(
    { id: "read-1", name: "read_file", input: { file_path: "nb.ipynb" } },
    context,
  );
  const edit = await toolRuntime.execute(
    {
      id: "edit-1",
      name: "edit_notebook",
      input: {
        notebook_path: "nb.ipynb",
        cell_id: "cell-a",
        new_source: "print('new')\n",
      },
    },
    context,
  );
  const write = await toolRuntime.execute(
    {
      id: "write-1",
      name: "write_file",
      input: { file_path: "nb.ipynb", content: notebookFixture({ cells: [markdownCell("cell-a", "# final\n")] }) },
    },
    context,
  );
  const reread = await toolRuntime.execute(
    { id: "read-2", name: "read_file", input: { file_path: "nb.ipynb" } },
    context,
  );

  assert.equal(read.type, "success");
  assert.equal(edit.type, "success");
  assert.equal(write.type, "success");
  assert.equal(reread.type, "success");
  assert.deepEqual(notifications, ["change:nb.ipynb", "save:nb.ipynb", "change:nb.ipynb", "save:nb.ipynb"]);
  assert.equal(context.writeSnapshots?.get(notebookPath)?.absolutePath, notebookPath);
  const updatedNotebook = JSON.parse(await workspace.read("nb.ipynb")) as { cells: Array<Record<string, unknown>> };
  assert.equal(updatedNotebook.cells[0]?.cell_type, "markdown");
  if (edit.type === "success") {
    const data = edit.data as EditNotebookOutput | undefined;
    assert.equal(data?.notebook_path, notebookPath);
    assert.equal(data?.edit_mode, "replace");
    assert.equal(data?.cell_id, "cell-a");
    const afterEdit = JSON.parse(data?.updated_file ?? "{}") as { cells?: Array<Record<string, unknown>> };
    assert.equal(afterEdit.cells?.[0]?.source, "print('new')\n");
    assert.equal(afterEdit.cells?.[0]?.execution_count, null);
    assert.deepEqual(afterEdit.cells?.[0]?.outputs, []);
  }
  if (reread.type === "success") {
    const rereadText = reread.content.map(contentToText).join("\n");
    assert.match(rereadText, /1\|# Cell 0 \(markdown\)/);
    assert.equal(/File unchanged since the last read/.test(rereadText), false);
  }
});

test("edit_notebook supports insert at the beginning and delete by synthetic cell index", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "nb.ipynb": notebookFixture({
      cells: [
        markdownCell("cell-a", "# first\n"),
        codeCell("cell-b", "print('second')\n"),
      ],
    }),
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createEditNotebookTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  const read = await toolRuntime.execute(
    { id: "read-1", name: "read_file", input: { file_path: "nb.ipynb" } },
    context,
  );
  const inserted = await toolRuntime.execute(
    {
      id: "edit-1",
      name: "edit_notebook",
      input: {
        notebook_path: "nb.ipynb",
        new_source: "print('prepended')\n",
        cell_type: "code",
        edit_mode: "insert",
      },
    },
    context,
  );
  const reread = await toolRuntime.execute(
    { id: "read-2", name: "read_file", input: { file_path: "nb.ipynb" } },
    context,
  );
  const deleted = await toolRuntime.execute(
    {
      id: "edit-2",
      name: "edit_notebook",
      input: {
        notebook_path: "nb.ipynb",
        cell_id: "cell-1",
        new_source: "",
        edit_mode: "delete",
      },
    },
    context,
  );

  assert.equal(read.type, "success");
  assert.equal(inserted.type, "success");
  assert.equal(reread.type, "success");
  assert.equal(deleted.type, "success");
  const notebook = JSON.parse(await workspace.read("nb.ipynb")) as { cells: Array<Record<string, unknown>> };
  assert.equal(notebook.cells.length, 2);
  assert.equal(notebook.cells[0]?.source, "print('prepended')\n");
  assert.equal(notebook.cells[1]?.id, "cell-b");
});

test("edit_notebook requires a full read and rejects stale notebook edits", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "nb.ipynb": notebookFixture({
      cells: [codeCell("cell-a", "print('old')\n")],
    }),
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createEditNotebookTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  const unread = await toolRuntime.execute(
    {
      id: "edit-1",
      name: "edit_notebook",
      input: { notebook_path: "nb.ipynb", cell_id: "cell-a", new_source: "print('new')\n" },
    },
    context,
  );
  const partialRead = await toolRuntime.execute(
    { id: "read-1", name: "read_file", input: { file_path: "nb.ipynb", offset: 1, limit: 1 } },
    context,
  );
  const afterPartialRead = await toolRuntime.execute(
    {
      id: "edit-2",
      name: "edit_notebook",
      input: { notebook_path: "nb.ipynb", cell_id: "cell-a", new_source: "print('new')\n" },
    },
    context,
  );
  const fullRead = await toolRuntime.execute(
    { id: "read-2", name: "read_file", input: { file_path: "nb.ipynb" } },
    context,
  );
  await waitForFreshMtimeTick();
  await workspace.write("nb.ipynb", notebookFixture({ cells: [codeCell("cell-a", "print('user')\n")] }));
  const stale = await toolRuntime.execute(
    {
      id: "edit-3",
      name: "edit_notebook",
      input: { notebook_path: "nb.ipynb", cell_id: "cell-a", new_source: "print('agent')\n" },
    },
    context,
  );

  assert.equal(unread.type, "error");
  assert.equal(partialRead.type, "success");
  assert.equal(afterPartialRead.type, "success", "partial read should register a snapshot that permits notebook edits");
  assert.equal(fullRead.type, "success");
  assert.equal(stale.type, "error");
  if (unread.type === "error") assert.equal(unread.error.code, "invalid_tool_input");
  if (stale.type === "error") assert.equal(stale.error.code, "invalid_tool_input");
});

test("edit_notebook is denied in plan mode and edit_file rejects notebooks", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "nb.ipynb": notebookFixture({
      cells: [markdownCell("cell-a", "# hi\n")],
    }),
  });
  t.after(() => workspace.cleanup());
  const planFixture = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createEditNotebookTool()],
    cwd: workspace.cwd,
    permissionMode: "plan",
  });
  const editFixture = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool(), createEditFileTool()],
    cwd: workspace.cwd,
    permissionMode: "acceptEdits",
  });

  const planRead = await planFixture.toolRuntime.execute(
    { id: "read-0", name: "read_file", input: { file_path: "nb.ipynb" } },
    planFixture.context,
  );
  const denied = await planFixture.toolRuntime.execute(
    {
      id: "edit-1",
      name: "edit_notebook",
      input: { notebook_path: "nb.ipynb", cell_id: "cell-a", new_source: "# nope\n" },
    },
    planFixture.context,
  );
  const read = await editFixture.toolRuntime.execute(
    { id: "read-1", name: "read_file", input: { file_path: "nb.ipynb" } },
    editFixture.context,
  );
  const rejected = await editFixture.toolRuntime.execute(
    {
      id: "edit-2",
      name: "edit_file",
      input: { file_path: "nb.ipynb", old_string: "# hi", new_string: "# bye" },
    },
    editFixture.context,
  );

  assert.equal(planRead.type, "success");
  assert.equal(denied.type, "error");
  assert.equal(read.type, "success");
  assert.equal(rejected.type, "error");
  if (denied.type === "error") assert.equal(denied.error.code, "permission_denied");
  if (rejected.type === "error") assert.equal(rejected.error.code, "invalid_tool_input");
});

function notebookFixture(options: {
  cells: NotebookCellFixture[];
  nbformat?: number;
  nbformat_minor?: number;
}): string {
  return `${JSON.stringify({
    cells: options.cells,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: options.nbformat ?? 4,
    nbformat_minor: options.nbformat_minor ?? 5,
  }, null, 1)}\n`;
}

type NotebookCellFixture = {
  id?: string;
  cell_type: "code" | "markdown";
  source: string;
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
};

function codeCell(
  id: string,
  source: string,
  extras?: Partial<NotebookCellFixture>,
): NotebookCellFixture {
  return {
    id,
    cell_type: "code",
    source,
    metadata: {},
    execution_count: null,
    outputs: [],
    ...extras,
  };
}

function markdownCell(id: string, source: string): NotebookCellFixture {
  return {
    id,
    cell_type: "markdown",
    source,
    metadata: {},
  };
}

async function waitForFreshMtimeTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
