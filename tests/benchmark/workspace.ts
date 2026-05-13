import { mkdtemp, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Task, WorkspaceFileSpec } from "./taskLoader.js";

export type TaskWorkspace = {
  cwd: string;
  cleanup(): Promise<void>;
};

/**
 * Prepare an isolated temp directory for a single task run.
 * Inline content files are written directly; asset-sourced files are copied
 * from `skillDir/assets/`.
 */
export async function prepareTaskWorkspace(
  task: Task,
  skillDir: string,
): Promise<TaskWorkspace> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `pinchbench-${task.taskId}-`));

  for (const spec of task.workspaceFiles) {
    if ("content" in spec) {
      const dest = path.join(cwd, spec.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, spec.content, "utf-8");
    } else {
      const source = path.join(skillDir, "assets", spec.source);
      const dest = path.join(cwd, spec.dest);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(source, dest);
    }
  }

  return {
    cwd,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}
