/**
 * edit_notebook 的写盘路径与 write_file / edit_file 共用 finalizeWorkspaceFileWrite，
 * 因此同样受真实落点/硬链接策略约束。这里钉住这条共用路径没有漏掉 notebook。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditNotebookTool } from "../../src/tool/builtin/editNotebook.js";
import { recordWriteSnapshot } from "../../src/tool/builtin/filesystem/writeSnapshots.js";
import type { PermissionRule } from "../../src/permission/index.js";

function context(cwd: string) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "default" as const,
    permissionContext: {
      mode: "default" as const,
      cwd,
      additionalWorkingDirectories: [] as string[],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [] as PermissionRule[], deny: [], ask: [] },
    },
    now: () => new Date("2026-10-23T00:00:00.000Z"),
  };
}

const NOTEBOOK = `${JSON.stringify(
  {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: "python" } },
    cells: [
      {
        cell_type: "code",
        id: "cell-abc",
        source: ["print(1)"],
        metadata: {},
        execution_count: null,
        outputs: [],
      },
    ],
  },
  null,
  1,
)}\n`;

async function withTempDirs(run: (workspace: string, outside: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "sati-notebook-ws-"));
  const outside = await mkdtemp(join(tmpdir(), "sati-notebook-out-"));
  try {
    await run(workspace, outside);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

test("edit_notebook writes through the guarded finalize path", async () => {
  await withTempDirs(async workspace => {
    const notebookPath = join(workspace, "nb.ipynb");
    await writeFile(notebookPath, NOTEBOOK);
    const ctx = context(workspace);
    recordWriteSnapshot(ctx, notebookPath, NOTEBOOK, Math.floor((await stat(notebookPath)).mtimeMs));

    const result = await createEditNotebookTool().execute(
      { notebook_path: "nb.ipynb", cell_id: "cell-abc", new_source: "print(2)" },
      ctx,
    );

    assert.equal(result.data?.new_source, "print(2)");
    const written = JSON.parse(await readFile(notebookPath, "utf8")) as { cells: Array<{ source: unknown }> };
    assert.deepEqual(written.cells[0]?.source, "print(2)");
  });
});

test("edit_notebook rejects a notebook with another hard link", async () => {
  await withTempDirs(async (workspace, outside) => {
    const victim = join(outside, "victim.ipynb");
    const notebookPath = join(workspace, "nb.ipynb");
    await writeFile(victim, NOTEBOOK);
    await link(victim, notebookPath);
    const ctx = context(workspace);
    recordWriteSnapshot(ctx, notebookPath, NOTEBOOK, Math.floor((await stat(notebookPath)).mtimeMs));

    await assert.rejects(
      createEditNotebookTool().execute({ notebook_path: "nb.ipynb", cell_id: "cell-abc", new_source: "print(2)" }, ctx),
      /hard links/,
    );
    assert.equal(await readFile(victim, "utf8"), NOTEBOOK);
  });
});
