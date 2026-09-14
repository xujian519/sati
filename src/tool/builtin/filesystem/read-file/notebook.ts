import { readFile } from "node:fs/promises";
import type { SatiToolExecutionOutput } from "../../../protocol/types.js";
import { readNotebook } from "../readNotebook.js";
import { recordWriteSnapshot } from "../writeSnapshots.js";
import { ensureTokenBudget, renderNumberedLines, sliceRenderedText } from "./text.js";
import type { ReadFileHandlerContext } from "./types.js";

/** notebook 读取：渲染所有 cell 后按 offset/limit 切片并编号。 */
export async function readNotebookFile({
  input,
  context,
  resolved,
  fileStat,
  markRead,
  kind,
}: ReadFileHandlerContext): Promise<SatiToolExecutionOutput> {
  const offset = input.offset ?? 1;
  const notebook = await readNotebook(resolved.absolutePath);
  const ranged = sliceRenderedText(notebook.text, offset, input.limit);
  const numbered = renderNumberedLines(ranged.lines, ranged.startLine);
  ensureTokenBudget(numbered, resolved.relativePath);
  markRead(fileStat.mtimeMs);
  recordWriteSnapshot(
    context,
    resolved.absolutePath,
    await readFile(resolved.absolutePath, { encoding: "utf8", signal: context.abortSignal }),
    fileStat.mtimeMs,
    { offset: input.offset, limit: input.limit },
  );
  return {
    content: [{ type: "text", text: numbered }],
    data: {
      filePath: resolved.relativePath,
      kind,
      startLine: ranged.startLine,
      endLine: ranged.endLine,
      totalLines: ranged.totalLines,
      truncated: ranged.truncated,
      cellCount: notebook.cellCount,
    },
    metadata: { truncated: ranged.truncated },
  };
}
