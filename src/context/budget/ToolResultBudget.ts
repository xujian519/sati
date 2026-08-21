import { mkdir, writeFile, access, copyFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalMediaReferenceBlock,
  CanonicalPdfBlock,
  CanonicalToolResultBlock,
  CanonicalToolResultContentBlock,
  CanonicalToolResultReferenceBlock,
} from "../../model/index.js";
import { flattenToolResultBlockText } from "../../model/index.js";
import { countTokens } from "./tokenizer.js";

/** Default model-visible text cap for inline tool results. */
export const DEFAULT_MAX_RESULT_SIZE_TOKENS = 10_000;
/** Byte safety cap used as a cheap guardrail before tokenization can dominate. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 200_000;
/** Inline preview length included alongside the persisted reference. */
export const PREVIEW_SIZE_BYTES = 12_000;

const EXACT_TOKEN_COUNT_MAX_BYTES = 40_000;
const TOKEN_ESTIMATE_SAMPLE_BYTES = 6_000;

export type ToolResultBudgetState = {
  replacements: Map<string, ToolResultReplacementRecord>;
  nextReadFileAliasIndex?: number;
};

export type ToolResultReplacementRecord = {
  toolCallId: string;
  isError?: boolean;
  path: string;
  readFilePath?: string;
  originalBytes: number;
  preview: string;
  mimeType?: string;
  reason: string;
};

export type MediaReplacementRecord = {
  id: string;
  toolCallId: string;
  path: string;
  originalBytes: number;
  preview: string;
  mimeType: string;
  mediaType: "image" | "pdf" | "audio";
  pages?: number;
  detail?: "auto" | "low" | "high";
  reason: string;
};

export type ToolResultBudgetOptions = {
  maxResultSizeChars?: number;
  maxResultSizeTokens?: number;
  previewBytes?: number;
  toolResultsDir: string;
  state?: ToolResultBudgetState;
};

export type ToolResultBudgetApplyOptions = {
  turnId?: string;
};

function createToolResultBudgetState(): ToolResultBudgetState {
  return { replacements: new Map(), nextReadFileAliasIndex: 1 };
}

/**
 * Replace tool_result blocks whose serialized text exceeds the budget with
 * structured `tool_result_reference` blocks. Persists the original body to
 * `{toolResultsDir}/{turnId}-{toolCallId}.{json|txt}` when a turn id is
 * available (write flag 'wx' to avoid overwriting on resume).
 */
export class ToolResultBudget {
  private readonly maxResultSizeChars: number;
  private readonly maxResultSizeTokens: number;
  private readonly previewBytes: number;
  private readonly toolResultsDir: string;
  private readonly state: ToolResultBudgetState;

  constructor(options: ToolResultBudgetOptions) {
    this.maxResultSizeChars = options.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
    this.maxResultSizeTokens = options.maxResultSizeTokens ?? DEFAULT_MAX_RESULT_SIZE_TOKENS;
    this.previewBytes = options.previewBytes ?? PREVIEW_SIZE_BYTES;
    this.toolResultsDir = resolve(options.toolResultsDir);
    this.state = options.state ?? createToolResultBudgetState();
  }

  getState(): ToolResultBudgetState {
    return this.state;
  }

  async applyToMessage(
    message: CanonicalMessage,
    options: ToolResultBudgetApplyOptions = {},
  ): Promise<CanonicalMessage> {
    if (message.role !== "user") {
      return message;
    }
    const primaryContent: CanonicalMessage["content"] = [];
    const mediaReferences: CanonicalMediaReferenceBlock[] = [];
    let modified = false;
    for (const block of message.content) {
      if (block.type !== "tool_result") {
        primaryContent.push(block);
        continue;
      }
      const replaced = await this.maybeReplaceToolResult(block, options);
      if (replaced.block !== block || replaced.mediaReferences.length > 0) {
        modified = true;
      }
      primaryContent.push(replaced.block);
      mediaReferences.push(...replaced.mediaReferences);
    }
    if (!modified) {
      return message;
    }
    return { ...message, content: [...primaryContent, ...mediaReferences] };
  }

  async applyToSupplementalMessage(
    message: CanonicalMessage,
    toolCallId: string,
    options: ToolResultBudgetApplyOptions = {},
  ): Promise<CanonicalMessage> {
    if (message.role !== "user") {
      return message;
    }
    const newContent: CanonicalContentBlock[] = [];
    let modified = false;
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index];
      const replaced = await this.maybeReplaceMedia(block, index, toolCallId, options);
      if (replaced !== block) {
        modified = true;
      }
      newContent.push(replaced);
    }
    return modified ? { ...message, content: newContent } : message;
  }

  private async maybeReplaceToolResult(
    block: CanonicalToolResultBlock,
    options: ToolResultBudgetApplyOptions,
  ): Promise<{
    block: CanonicalToolResultBlock | CanonicalToolResultReferenceBlock;
    mediaReferences: CanonicalMediaReferenceBlock[];
  }> {
    if (!block.content.some(isToolResultMediaBlock)) {
      return { block: await this.maybeReplaceTextToolResult(block, options), mediaReferences: [] };
    }

    const content: CanonicalToolResultContentBlock[] = [];
    const mediaReferences: CanonicalMediaReferenceBlock[] = [];

    for (let index = 0; index < block.content.length; index += 1) {
      const entry = block.content[index];
      if (!isToolResultMediaBlock(entry)) {
        content.push(entry);
        continue;
      }

      const replaced = await this.maybeReplaceMedia(entry, index, block.toolCallId, options);
      if (replaced.type === "media_reference") {
        mediaReferences.push(replaced);
        content.push({ type: "text", text: replaced.preview });
      } else {
        content.push(entry);
      }
    }

    return {
      block: mediaReferences.length > 0 ? { ...block, content } : block,
      mediaReferences,
    };
  }

  private async maybeReplaceTextToolResult(
    block: CanonicalToolResultBlock,
    options: ToolResultBudgetApplyOptions,
  ): Promise<CanonicalToolResultBlock | CanonicalToolResultReferenceBlock> {
    const replacementKey = scopedToolResultKey(block.toolCallId, options.turnId);
    if (this.state.replacements.has(replacementKey)) {
      return this.toReferenceBlock(this.state.replacements.get(replacementKey)!);
    }

    const flat = flattenToolResultBlockText(block);
    const byteLength = Buffer.byteLength(flat, "utf8");
    if (this.shouldInlineTextResult(flat, byteLength)) {
      return block;
    }

    const isJson = looksLikeJson(flat);
    const ext = isJson ? "json" : "txt";
    const path = resolve(this.toolResultsDir, `${replacementKey}.${ext}`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await access(path);
      // already exists — do not overwrite (legacy 'wx' flag); reuse existing record.
    } catch {
      await writeFile(path, flat, { flag: "wx", mode: 0o600, encoding: "utf8" });
    }
    const readFilePath = await this.createReadFileAlias(path, ext);

    // 取回提示计入预览预算：替换件自带显式指令，模型无需从 read_file
    // 描述猜测即可用 read_file 读回全文（与 read_file 描述中的引导行
    // 形成双保险）。提示本身也受 previewBytes 约束（罕见的小预算/超长
    // 路径下截断提示而非溢出预览）。
    const retrievalHint = buildRetrievalHint(readFilePath, path, byteLength);
    const boundedHint =
      Buffer.byteLength(retrievalHint, "utf8") > this.previewBytes
        ? truncateToBytes(retrievalHint, this.previewBytes)
        : retrievalHint;
    const previewBudget = Math.max(0, this.previewBytes - Buffer.byteLength(boundedHint, "utf8"));
    const preview = `${headTailPreview(flat, previewBudget)}${boundedHint}`;
    const record: ToolResultReplacementRecord = {
      toolCallId: block.toolCallId,
      isError: block.isError,
      path,
      readFilePath,
      originalBytes: byteLength,
      preview,
      mimeType: isJson ? "application/json" : "text/plain",
      reason: "tool_result_too_large",
    };
    this.state.replacements.set(replacementKey, record);
    return this.toReferenceBlock(record);
  }

  private shouldInlineTextResult(text: string, byteLength: number): boolean {
    if (byteLength > this.maxResultSizeChars) {
      return false;
    }
    return estimateTokens(text, byteLength) <= this.maxResultSizeTokens;
  }

  private toReferenceBlock(record: ToolResultReplacementRecord): CanonicalToolResultReferenceBlock {
    return {
      type: "tool_result_reference",
      toolCallId: record.toolCallId,
      isError: record.isError,
      path: record.path,
      readFilePath: record.readFilePath,
      originalBytes: record.originalBytes,
      preview: record.preview,
      hasMore: Buffer.byteLength(record.preview, "utf8") < record.originalBytes,
      mimeType: record.mimeType,
      reason: record.reason,
    };
  }

  private async createReadFileAlias(sourcePath: string, ext: string): Promise<string> {
    const { refsDir, workspaceRoot } = this.resolveReadFileAliasLocation();
    await mkdir(refsDir, { recursive: true, mode: 0o700 });

    const normalizedExt = extname(ext) ? ext.slice(1) : ext;
    while (true) {
      const index = this.state.nextReadFileAliasIndex ?? 1;
      this.state.nextReadFileAliasIndex = index + 1;
      const aliasPath = resolve(refsDir, `result-${String(index).padStart(4, "0")}.${normalizedExt || "txt"}`);
      try {
        await copyFile(sourcePath, aliasPath, fsConstants.COPYFILE_EXCL);
        // readFilePath 是协议级 workspace-relative 路径（供 read_file 的
        // file_path 直接使用），统一 `/` 分隔保证跨平台稳定。
        return relative(workspaceRoot, aliasPath).replace(/\\/g, "/");
      } catch (error) {
        if (isFileExistsError(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private resolveReadFileAliasLocation(): { refsDir: string; workspaceRoot: string } {
    const maybeToolResultsRoot = dirname(this.toolResultsDir);
    if (basename(maybeToolResultsRoot) === "tool-results") {
      return {
        refsDir: resolve(maybeToolResultsRoot, "refs"),
        workspaceRoot: dirname(dirname(maybeToolResultsRoot)),
      };
    }
    return {
      refsDir: resolve(this.toolResultsDir, "refs"),
      workspaceRoot: dirname(dirname(this.toolResultsDir)),
    };
  }

  private async maybeReplaceMedia(
    block: CanonicalContentBlock,
    index: number,
    toolCallId: string,
    options: ToolResultBudgetApplyOptions,
  ): Promise<CanonicalContentBlock> {
    if (block.type !== "image" && block.type !== "pdf" && block.type !== "audio") {
      return block;
    }
    const originalBytes = mediaOriginalBytes(block);
    const encodedBytes = Buffer.byteLength(block.data, "utf8");
    if (encodedBytes <= this.maxResultSizeChars) {
      return block;
    }

    const mediaType = block.type;
    const mimeType = block.mimeType;
    const ext = extensionForMedia(mediaType, mimeType);
    const id = `${scopedToolResultKey(toolCallId, options.turnId)}-${mediaType}-${index}-${hashString(block.data).slice(0, 12)}`;
    const path = resolve(this.toolResultsDir, `${id}.${ext}`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await access(path);
    } catch {
      await writeFile(path, block.data, { flag: "wx", mode: 0o600, encoding: "utf8" });
    }

    const record: MediaReplacementRecord = {
      id,
      toolCallId,
      path,
      originalBytes,
      preview: mediaPreview(mediaType, mimeType, originalBytes, block),
      mimeType,
      mediaType,
      reason: "media_result_too_large",
      ...(block.type === "pdf" && block.pages !== undefined ? { pages: block.pages } : {}),
      ...(block.type === "image" && block.detail ? { detail: block.detail } : {}),
    };
    return this.toMediaReferenceBlock(record);
  }

  private toMediaReferenceBlock(record: MediaReplacementRecord): CanonicalMediaReferenceBlock {
    return {
      type: "media_reference",
      toolCallId: record.toolCallId,
      path: record.path,
      originalBytes: record.originalBytes,
      preview: record.preview,
      hasMore: true,
      mimeType: record.mimeType,
      mediaType: record.mediaType,
      ...(record.pages !== undefined ? { pages: record.pages } : {}),
      ...(record.detail ? { detail: record.detail } : {}),
      reason: record.reason,
    };
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(buffer.length, maxBytes);
  while (end > 0 && (buffer[end] & 0b11000000) === 0b10000000) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/** Keep the last `maxBytes` bytes of `value`, UTF-8 safe (no split codepoints). */
function truncateToBytesFromEnd(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const buffer = Buffer.from(value, "utf8");
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0b11000000) === 0b10000000) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

/**
 * Separator byte upper bound. The omitted-bytes count is rendered literally,
 * so budget the fixed text plus a 15-digit ceiling (≈1 PB) — enough for any
 * realistic spill body — to guarantee the rendered preview never exceeds the
 * caller's budget.
 */
const SEPARATOR_MAX_BYTES = Buffer.byteLength("\n\n... [123456789012345 bytes omitted] ...\n\n");

/**
 * Head + tail preview: first half of the content budget from the start,
 * last half from the end (both byte-aware), joined by a separator. The
 * rendered result is guaranteed to fit within `budgetBytes`.
 */
function headTailPreview(value: string, budgetBytes: number): string {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= budgetBytes) {
    return value;
  }
  if (budgetBytes <= 64) {
    return truncateToBytes(value, budgetBytes);
  }
  const contentBudget = Math.max(0, budgetBytes - SEPARATOR_MAX_BYTES);
  const halfBudget = Math.floor(contentBudget / 2);
  if (halfBudget <= 0) {
    return truncateToBytes(value, budgetBytes);
  }
  const head = truncateToBytes(value, halfBudget);
  const tail = truncateToBytesFromEnd(value, halfBudget);
  const omitted = totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `${head}\n\n... [${omitted} bytes omitted] ...\n\n${tail}`;
}

/**
 * Model-facing retrieval hint appended to a persisted reference's preview.
 * Names the workspace-relative read_file target when one exists (absolute
 * spill path otherwise) so the model can deterministically read the full
 * body back instead of relying on the preview alone.
 */
function buildRetrievalHint(readFilePath: string | undefined, path: string, originalBytes: number): string {
  const target = readFilePath ?? path;
  return `\n\n[Full result persisted to ${target} (${originalBytes} bytes). Use read_file with file_path="${target}" to read the full content.]`;
}

function estimateTokens(text: string, byteLength: number): number {
  if (byteLength <= EXACT_TOKEN_COUNT_MAX_BYTES) {
    return countTokens(text);
  }
  const samples = sampleTextForTokenEstimate(text);
  let sampledBytes = 0;
  let sampledTokens = 0;
  for (const sample of samples) {
    sampledBytes += Buffer.byteLength(sample, "utf8");
    sampledTokens += countTokens(sample);
  }
  if (sampledBytes === 0) {
    return 0;
  }
  return Math.ceil((sampledTokens / sampledBytes) * byteLength);
}

function sampleTextForTokenEstimate(text: string): string[] {
  if (text.length <= TOKEN_ESTIMATE_SAMPLE_BYTES * 3) {
    return [text];
  }
  const middleStart = Math.max(0, Math.floor((text.length - TOKEN_ESTIMATE_SAMPLE_BYTES) / 2));
  return [
    text.slice(0, TOKEN_ESTIMATE_SAMPLE_BYTES),
    text.slice(middleStart, middleStart + TOKEN_ESTIMATE_SAMPLE_BYTES),
    text.slice(-TOKEN_ESTIMATE_SAMPLE_BYTES),
  ];
}

function isToolResultMediaBlock(
  block: CanonicalToolResultContentBlock,
): block is Extract<CanonicalToolResultContentBlock, { type: "image" | "pdf" }> {
  return block.type === "image" || block.type === "pdf";
}

function mediaOriginalBytes(block: Extract<CanonicalContentBlock, { type: "image" | "pdf" | "audio" }>): number {
  return ("bytes" in block ? block.bytes : undefined) ?? Buffer.byteLength(block.data, "utf8");
}

function scopedToolResultKey(toolCallId: string, turnId: string | undefined): string {
  const safeToolCallId = safePathPart(toolCallId) || "tool-call";
  const safeTurnId = turnId === undefined ? undefined : safePathPart(turnId);
  return safeTurnId ? `${safeTurnId}-${safeToolCallId}` : safeToolCallId;
}

function safePathPart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function extensionForMedia(mediaType: "image" | "pdf" | "audio", mimeType: string): string {
  if (mediaType === "pdf") return "pdf.b64";
  const subType = mimeType
    .split("/")[1]
    ?.toLowerCase()
    .replace(/[^a-z0-9.+-]/g, "");
  return `${subType || mediaType}.b64`;
}

function mediaPreview(
  mediaType: "image" | "pdf" | "audio",
  mimeType: string,
  originalBytes: number,
  block: Extract<CanonicalContentBlock, { type: "image" | "pdf" | "audio" }>,
): string {
  const size = `${originalBytes} bytes`;
  if (mediaType === "pdf") {
    const pages = (block as CanonicalPdfBlock).pages;
    return `[PDF omitted from memory: ${mimeType}, ${size}${pages ? `, ${pages} pages` : ""}]`;
  }
  return `[${mediaType} omitted from memory: ${mimeType}, ${size}]`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
