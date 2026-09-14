import type { SatiToolExecutionOutput } from "../../../protocol/types.js";
import { SatiToolRuntimeError } from "../../../protocol/errors.js";
import { applyResultSizeLimit } from "../../../protocol/result.js";
import { countTokens } from "../../../../context/budget/tokenizer.js";
import { readFileInRange } from "../readFileInRange.js";
import { recordWriteSnapshot } from "../writeSnapshots.js";
import {
  DEFAULT_LARGE_TEXT_PREVIEW_LINES,
  LARGE_TEXT_AUTO_PAGE_BYTES,
  MAX_TEXT_TOKENS,
  OVERSIZED_LINE_PREVIEW_BYTES,
  SAFE_TEXT_BUDGET_BYTES,
} from "./constants.js";
import type { ReadFileHandlerContext } from "./types.js";

function renderReadableRange(content: string, startLine: number, totalLines: number): string {
  if (content.length > 0) {
    return renderNumberedLines(content.split("\n"), startLine);
  }
  if (totalLines === 0) {
    return "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
  }
  return `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} lines.</system-reminder>`;
}

export function renderNumberedLines(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}|${line}`).join("\n");
}

function renderReadMoreNotice(
  filePath: string,
  nextOffset: number,
  limit: number,
  reason: "large_file" | "tool_result_ref",
): string {
  const cause =
    reason === "large_file"
      ? "The file is too large to read in one response, so read_file returned"
      : "The persisted tool result was too large for the requested range, so read_file returned";
  return (
    "\n<system-reminder>" +
    `${cause} the first ${limit} lines. ` +
    `Continue with read_file({ file_path: "${filePath}", offset: ${nextOffset}, limit: ${limit} }) if you need more.` +
    "</system-reminder>"
  );
}

function isManagedToolResultRefPath(filePath: string): boolean {
  return /^\.sati[\\/]tool-results[\\/]refs[\\/]result-\d+\.(?:txt|json)$/.test(filePath);
}

function renderOversizedLinePreview(text: string, filePath: string, offset: number): string {
  const limitedContent = applyResultSizeLimit([{ type: "text", text }], OVERSIZED_LINE_PREVIEW_BYTES).content[0];
  const limited = limitedContent?.type === "text" ? limitedContent.text : text;
  return (
    limited +
    "\n<system-reminder>" +
    "This line range is still too large for the model context, so read_file returned a head/tail preview. " +
    `Use a smaller line range, for example read_file({ file_path: "${filePath}", offset: ${offset}, limit: 1 }), or use grep to find the relevant section.` +
    "</system-reminder>"
  );
}

function isOverTextBudget(text: string): boolean {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > LARGE_TEXT_AUTO_PAGE_BYTES) {
    return true;
  }
  if (bytes <= SAFE_TEXT_BUDGET_BYTES) {
    return false;
  }
  return countTokens(text) > MAX_TEXT_TOKENS;
}

// countTokens (o200k BPE) is expensive for large strings (~8s per 100KB).
// read_file calls the budget check several times on the same text while
// auto-shrinking; memoize per exact text to avoid re-tokenizing.
const textBudgetMemo = new Map<string, boolean>();

function isOverTextBudgetMemo(text: string): boolean {
  const cached = textBudgetMemo.get(text);
  if (cached !== undefined) return cached;
  const result = isOverTextBudget(text);
  if (textBudgetMemo.size >= 64) {
    textBudgetMemo.clear();
  }
  textBudgetMemo.set(text, result);
  return result;
}

export function ensureTokenBudget(text: string, filePath: string, suggestedOffset?: number): void {
  if (isOverTextBudgetMemo(text)) {
    const action =
      suggestedOffset === undefined
        ? "Use offset and limit to read a smaller portion."
        : `Use a smaller limit, for example read_file({ file_path: "${filePath}", offset: ${suggestedOffset}, limit: 500 }).`;
    throw new SatiToolRuntimeError(
      "result_too_large",
      `File content from ${filePath} exceeds the text token budget. ${action}`,
    );
  }
}

export function sliceRenderedText(
  text: string,
  startLine: number,
  limit?: number,
): { lines: string[]; startLine: number; endLine: number; totalLines: number; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const startIndex = Math.max(0, startLine - 1);
  const selected = limit === undefined ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + limit);
  const actualStart = selected.length > 0 ? startLine : Math.min(startLine, lines.length + 1);
  const actualEnd = selected.length > 0 ? actualStart + selected.length - 1 : actualStart - 1;
  return {
    lines: selected,
    startLine: actualStart,
    endLine: actualEnd,
    totalLines: lines.length,
    truncated: startIndex > 0 || (limit !== undefined && startIndex + limit < lines.length),
  };
}

/** 文本读取：按 offset/limit 分页、超预算二分收缩、超限预览与续读提示。 */
export async function readTextFile({
  input,
  context,
  resolved,
  fileStat,
  markRead,
  kind,
}: ReadFileHandlerContext): Promise<SatiToolExecutionOutput> {
  const offset = input.offset ?? 1;
  const effectiveLimit =
    input.limit ?? (fileStat.size > LARGE_TEXT_AUTO_PAGE_BYTES ? DEFAULT_LARGE_TEXT_PREVIEW_LINES : undefined);
  let ranged = await readFileInRange(resolved.absolutePath, offset, effectiveLimit, context.abortSignal);
  let text = renderReadableRange(ranged.content, ranged.startLine, ranged.totalLines);
  let autoPaged = input.limit === undefined && effectiveLimit !== undefined;
  let toolResultRefAutoPaged = false;
  // 超预算时二分收缩行数。autoPaged（大文件自动翻页）与 tool-result ref
  // （托管结果文件）两条路径的循环体一致，仅标记位不同，合并为一个 helper。
  const shrinkToBudget = async (markRef: boolean) => {
    while (isOverTextBudgetMemo(text) && ranged.lineCount > 1) {
      const nextLimit = Math.max(1, Math.floor(ranged.lineCount / 2));
      ranged = await readFileInRange(resolved.absolutePath, offset, nextLimit, context.abortSignal);
      text = renderReadableRange(ranged.content, ranged.startLine, ranged.totalLines);
      if (markRef) toolResultRefAutoPaged = true;
    }
  };
  if (autoPaged) {
    await shrinkToBudget(false);
  } else if (isManagedToolResultRefPath(resolved.relativePath)) {
    await shrinkToBudget(true);
  }
  if (isOverTextBudgetMemo(text) && input.limit === undefined) {
    autoPaged = true;
    text = renderOversizedLinePreview(text, resolved.relativePath, ranged.startLine);
  }
  if (isOverTextBudgetMemo(text) && toolResultRefAutoPaged) {
    text = renderOversizedLinePreview(text, resolved.relativePath, ranged.startLine);
  }
  ensureTokenBudget(text, resolved.relativePath, ranged.startLine);
  if (autoPaged && ranged.truncated) {
    text += renderReadMoreNotice(resolved.relativePath, ranged.endLine + 1, ranged.lineCount, "large_file");
  }
  if (toolResultRefAutoPaged && ranged.truncated) {
    text += renderReadMoreNotice(resolved.relativePath, ranged.endLine + 1, ranged.lineCount, "tool_result_ref");
  }
  markRead(ranged.mtimeMs);
  recordWriteSnapshot(context, resolved.absolutePath, ranged.fullContent ?? ranged.content, ranged.mtimeMs, {
    offset: input.offset,
    limit: input.limit ?? (ranged.fullContent === undefined ? ranged.lineCount : undefined),
  });
  return {
    content: [{ type: "text", text }],
    data: {
      filePath: resolved.relativePath,
      kind,
      startLine: ranged.startLine,
      endLine: ranged.endLine,
      totalLines: ranged.totalLines,
      truncated: ranged.truncated,
      autoPaged: autoPaged || toolResultRefAutoPaged,
      nextOffset: ranged.truncated ? ranged.endLine + 1 : undefined,
    },
    metadata: { truncated: ranged.truncated },
  };
}
