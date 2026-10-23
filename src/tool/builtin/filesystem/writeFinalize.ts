import { stat } from "node:fs/promises";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import { writeTextFile } from "./writeTextFile.js";
import { resolveVerifiedWriteTarget } from "./writeTarget.js";
import { invalidateReadFileState, recordWriteSnapshot } from "./writeSnapshots.js";

/**
 * write_file / edit_file / edit_notebook 共用的写盘收尾序列：写入 → 取新 mtime
 * → 失效 read_file 去重状态 → 登记写快照 → 通知 LSP/宿主 didChange + didSave。
 *
 * 写入前重新解析并复核真实落点（见 writeTarget.ts），把「权限校验 → 落盘」之间
 * 软链被重指、目标被替换的窗口收在打开目标的 fd 复核里。
 */
export async function finalizeWorkspaceFileWrite(
  context: SatiToolRuntimeContext,
  paths: { absolutePath: string; relativePath: string; root: string },
  content: string,
  previousContent: string | null,
): Promise<{ action: "created" | "overwritten"; mtimeMs: number }> {
  const target = await resolveVerifiedWriteTarget(paths.absolutePath, context);
  const action = await writeTextFile(target, content, { allowOverwrite: true });
  const fileStat = await stat(paths.absolutePath);
  const mtimeMs = Math.floor(fileStat.mtimeMs);
  invalidateReadFileState(context, paths.absolutePath);
  recordWriteSnapshot(context, paths.absolutePath, content, mtimeMs);

  const update = {
    absolutePath: paths.absolutePath,
    relativePath: paths.relativePath,
    root: paths.root,
    content,
    previousContent,
  };
  await context.fileUpdateNotifier?.didChange?.(update);
  await context.fileUpdateNotifier?.didSave?.(update);
  return { action, mtimeMs };
}
