import { open, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { TtlCache } from "../../shared/ttl-cache.js";
import type { AgentTranscriptDiagnostic, AgentTranscriptEntry } from "./TranscriptEntry.js";

export const DEFAULT_MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024;

export type AgentTranscriptReadResult = {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
};

export type ReadTranscriptOptions = {
  maxBytes?: number;
};

/**
 * transcript 解析的两条路径：
 *
 * 默认（tail-append 增量，SATI_TRANSCRIPT_TAIL=0 回滚）：
 * 首次读取全量解析后建立进程级状态；文件追加（transcript 是追加型日志，
 * 写入者恒以 \n 结尾）时只读 [上次行边界, EOF) 的新字节，与上次遗留的半行
 * 字节 Buffer.concat 拼合后解析新行——旧字节零重读。三条守卫防御文件替换/
 * 回滚：size 回缩、mtime 回退、sequence 回退（新 entry 序号不大于旧最后一条）
 * → 全量重读重置状态。快路径（mtime+size 未变）0 次文件读取，返回共享元素
 * 浅拷贝。并发读取经 state.pending promise 链串行化（同 path 不重复读段）。
 * 多次读取共享 entry 对象（批 4 投影缓存以长度+指纹键控，元素引用稳定）。
 *
 * 回滚路径（SATI_TRANSCRIPT_TAIL=0）：旧实现，5s TTL + 全量读取重解析。
 */
const TRANSCRIPT_CACHE_TTL_MS = 5_000;
const TRANSCRIPT_CACHE_MAX = 32;

/** tail-append 增量状态上限（path 数，LRU 淘汰）。 */
const TAIL_STATE_MAX = 64;

type TranscriptCacheEntry = {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
  mtimeMs: number;
  size: number;
};

const transcriptCache = new TtlCache<string, TranscriptCacheEntry>({
  ttlMs: TRANSCRIPT_CACHE_TTL_MS,
  maxSize: TRANSCRIPT_CACHE_MAX,
});

/** tail-append 增量读取的进程级状态（按 path）。 */
type TranscriptTailState = {
  /** 已解析 entry（元素共享给调用方；undefined = 尚未初始化）。 */
  entries?: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
  mtimeMs: number;
  /** 已确认读取到的文件字节数（下一次增量的起点）。 */
  size: number;
  /** 上次读取结束时未完成的行的字节（UTF-8 前缀，与后续字节 concat 可拼回完整字符）。 */
  tail: Buffer;
  /** 最后一个已见行的文件行号（含空行）；无 tail 时下一段第 0 行 = lineCount + 1。 */
  lineCount: number;
  /** tail 半行所在的文件行号（有 tail 时；拼接行复用它，避免行号漂移）。 */
  tailLineNumber?: number;
  /** 并发读取串行化链（同 path 一次只跑一个 stat+read 步）。 */
  pending?: Promise<unknown>;
};

const tailStates = new Map<string, TranscriptTailState>();

function getTailState(path: string): TranscriptTailState {
  let state = tailStates.get(path);
  if (state === undefined) {
    state = {
      diagnostics: [],
      mtimeMs: 0,
      size: 0,
      tail: Buffer.alloc(0),
      lineCount: 0,
    };
    tailStates.set(path, state);
    // LRU 上限：淘汰最久未触摸的 path（getTailState 命中时刷新位置）。
    if (tailStates.size > TAIL_STATE_MAX) {
      const oldest = tailStates.keys().next().value;
      if (oldest !== undefined && oldest !== path) tailStates.delete(oldest);
    }
  } else {
    tailStates.delete(path);
    tailStates.set(path, state);
  }
  return state;
}

export async function readTranscript(
  path: string,
  options: ReadTranscriptOptions = {},
): Promise<AgentTranscriptReadResult> {
  // 每次调用读 env：测试可在运行期切换回滚开关。
  if (process.env.SATI_TRANSCRIPT_TAIL === "0") {
    return readTranscriptLegacy(path, options);
  }
  const state = getTailState(path);
  const run = state.pending ?? Promise.resolve();
  const next = run.then(() => readTailStep(path, options, state));
  // 错误不外泄到链：下一位调用者从干净 promise 开始（错误本身照常抛给调用方）。
  state.pending = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readTailStep(
  path: string,
  options: ReadTranscriptOptions,
  state: TranscriptTailState,
): Promise<AgentTranscriptReadResult> {
  let fileStat: Stats;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      // 文件被删除：状态作废，下次读取重建。
      tailStates.delete(path);
      return {
        entries: [],
        diagnostics: [
          {
            code: "transcript_missing",
            severity: "warning",
            message: `Transcript ${path} does not exist.`,
          },
        ],
      };
    }
    throw error;
  }

  // 快路径：mtime+size 未变 → 共享元素浅拷贝（0 次文件读取）。
  if (state.entries !== undefined && fileStat.mtimeMs === state.mtimeMs && fileStat.size === state.size) {
    return { entries: [...state.entries], diagnostics: state.diagnostics };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_READ_BYTES;
  if (fileStat.size > maxBytes) {
    tailStates.delete(path);
    return {
      entries: [],
      diagnostics: [
        {
          code: "transcript_too_large",
          severity: "error",
          message: `Transcript ${path} is larger than ${maxBytes} bytes.`,
        },
      ],
    };
  }

  if (state.entries !== undefined) {
    // 守卫 1/2：size 回缩 / mtime 回退（截断或替换）→ 全量重读；
    // size 相同但 mtime 不同（同尺寸覆盖）同样全量。仅 size 增长走增量。
    const rolledBack = fileStat.size < state.size || fileStat.mtimeMs < state.mtimeMs;
    if (!rolledBack && fileStat.size > state.size) {
      const incremental = await tryReadIncremental(path, fileStat, state);
      if (incremental !== undefined) {
        return incremental;
      }
      // 守卫 3（读不完整/sequence 回退）触发 → 全量重读。
    }
  }

  return readFullAndCache(path, fileStat, state);
}

/**
 * 增量读取 [上次行边界, EOF)：与遗留半行拼接后解析新行。
 * 失败（读取期间截断 / sequence 回退）返回 undefined → 调用方全量重读。
 */
async function tryReadIncremental(
  path: string,
  fileStat: Stats,
  state: TranscriptTailState,
): Promise<AgentTranscriptReadResult | undefined> {
  // 调用方保证 state.entries 已初始化（readTailStep 仅在 entries !== undefined 时走增量）。
  const existing = state.entries!;
  // 增量起点 = 已确认读取到的文件字节数。tail 字节已读过（留在文件里），
  // 只需读 [state.size, EOF) 的新字节，与 tail 拼接还原完整行——切勿
  // 从 state.size - tail.length 起读（会把 tail 字节重复读一遍导致错位）。
  const start = state.size;
  const length = fileStat.size - start;
  if (length <= 0) return undefined;
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  const handle = await open(path, "r");
  try {
    ({ bytesRead } = await handle.read(buffer, 0, length, start));
  } finally {
    await handle.close();
  }
  if (bytesRead < length) {
    // 守卫 3a：读取期间文件被截断（内容不完整）→ 全量重读。
    return undefined;
  }

  const combined = Buffer.concat([state.tail, buffer]);
  const text = combined.toString("utf8");
  const rawLines = text.split(/\r?\n/);
  const segmentCount = rawLines.length;
  // 段内第 0 行行号：有遗留半行时复用其占位行号，否则接在已见最后行之后。
  const firstLineNumber = state.tail.length > 0 ? (state.tailLineNumber ?? state.lineCount + 1) : state.lineCount + 1;
  const lastLineNumber = firstLineNumber + segmentCount - 1;

  const newEntries: AgentTranscriptEntry[] = [];
  const newDiagnostics: AgentTranscriptDiagnostic[] = [];
  let tail = Buffer.alloc(0);
  let tailLineNumber: number | undefined;
  for (let index = 0; index < segmentCount; index += 1) {
    const line = rawLines[index]!;
    const lineNumber = firstLineNumber + index;
    if (index === segmentCount - 1 && !line.trim()) {
      // 段末空段（文件以 \n 结尾）：tail 清空。
      continue;
    }
    const parsed = parseLine(line, lineNumber);
    if (parsed.entry !== undefined) newEntries.push(parsed.entry);
    if (parsed.diagnostic !== undefined) newDiagnostics.push(parsed.diagnostic);
    if (index === segmentCount - 1 && !parsed.complete) {
      // 段末无 \n 结尾且不是完整 JSON 行 → 半行，保留字节等下一轮拼接。
      // （诊断照常记入：本轮看到的不完整行。）
      tail = Buffer.from(line, "utf8");
      tailLineNumber = lineNumber;
    }
  }

  // 守卫 3b：sequence 回退（文件被替换重写 / 旧字节被覆盖）→ 全量重读。
  let prev = existing[existing.length - 1];
  for (const entry of newEntries) {
    if (prev !== undefined && entry.sequence <= prev.sequence) {
      return undefined;
    }
    prev = entry;
  }

  existing.push(...newEntries);
  state.diagnostics.push(...newDiagnostics);
  state.mtimeMs = fileStat.mtimeMs;
  state.size = start + bytesRead;
  state.tail = tail;
  state.lineCount = lastLineNumber;
  state.tailLineNumber = tail.length > 0 ? tailLineNumber : undefined;
  return { entries: [...existing], diagnostics: state.diagnostics };
}

/** 全量读取 + 解析，重建状态（首次读取 / 守卫触发 / 回滚均经此）。 */
async function readFullAndCache(
  path: string,
  fileStat: Stats,
  state: TranscriptTailState,
): Promise<AgentTranscriptReadResult> {
  const content = await readFile(path, "utf8");
  const result = parseTranscript(content);
  state.entries = result.entries;
  state.diagnostics = result.diagnostics;
  state.mtimeMs = fileStat.mtimeMs;
  state.size = fileStat.size;
  // 尾部半行：无 \n 结尾且最后一段不是合法 JSON → 保留字节（该段解析失败
  // 的诊断已由 parseTranscript 记入；下一轮增量拼接成功后 entry 补达）。
  state.tail = extractTrailingTail(content);
  state.lineCount = result.lineCount;
  state.tailLineNumber = state.tail.length > 0 ? result.lineCount : undefined;
  return { entries: [...result.entries], diagnostics: result.diagnostics };
}

/** 无 \n 结尾且非完整 JSON 行的尾段字节（否则空）。 */
function extractTrailingTail(content: string): Buffer {
  if (content === "" || content.endsWith("\n")) return Buffer.alloc(0);
  const last = content.slice(content.lastIndexOf("\n") + 1);
  if (last.trim() === "" || isJsonLine(last)) return Buffer.alloc(0);
  return Buffer.from(last, "utf8");
}

type ParsedLine = {
  entry?: AgentTranscriptEntry;
  diagnostic?: AgentTranscriptDiagnostic;
  /** 是否为可解析 JSON 行（空行视为完整；坏 JSON = false → 可能是不完整半行）。 */
  complete: boolean;
};

/** 解析单行：空行跳过；坏 JSON → line_invalid 诊断且 complete=false。 */
function parseLine(line: string, lineNumber: number): ParsedLine {
  if (!line.trim()) {
    return { complete: true };
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isTranscriptEntry(parsed)) {
      return { entry: parsed, complete: true };
    }
    return {
      diagnostic: {
        code: "transcript_entry_invalid",
        severity: "error",
        message: "Transcript entry has an invalid shape.",
        line: lineNumber,
      },
      complete: true,
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "transcript_line_invalid",
        severity: "error",
        message: error instanceof Error ? error.message : "Transcript line is not valid JSON.",
        line: lineNumber,
      },
      complete: false,
    };
  }
}

/** 是否为完整 JSON 行（单行 JSON.parse 成功即完整，形状由调用方另行校验）。 */
function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function parseTranscript(content: string): {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
  lineCount: number;
} {
  const entries: AgentTranscriptEntry[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  const lines = content.split(/\r?\n/);
  // 已见最后一行行号：尾空段（以 \n 结尾）不算行。
  const lineCount = lines.length - (content === "" || content.endsWith("\n") ? 1 : 0);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseLine(lines[index]!, index + 1);
    if (parsed.entry !== undefined) {
      entries.push(parsed.entry);
    } else if (parsed.diagnostic !== undefined) {
      diagnostics.push(parsed.diagnostic);
    }
  }

  entries.sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return left.createdAt.localeCompare(right.createdAt);
  });
  return { entries, diagnostics, lineCount };
}

function isTranscriptEntry(value: unknown): value is AgentTranscriptEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.type === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.sequence === "number" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** 回滚路径（SATI_TRANSCRIPT_TAIL=0）：5s TTL + 每次变化全量重解析（旧行为）。 */
async function readTranscriptLegacy(path: string, options: ReadTranscriptOptions): Promise<AgentTranscriptReadResult> {
  try {
    const fileStat = await stat(path);
    const cached = transcriptCache.get(path);
    if (cached !== undefined && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      // 返回浅拷贝数组（元素共享），防止调用方修改数组污染缓存。
      return { entries: [...cached.entries], diagnostics: cached.diagnostics };
    }
    return await readAndCache(path, options, fileStat);
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        entries: [],
        diagnostics: [
          {
            code: "transcript_missing",
            severity: "warning",
            message: `Transcript ${path} does not exist.`,
          },
        ],
      };
    }
    throw error;
  }
}

async function readAndCache(
  path: string,
  options: ReadTranscriptOptions,
  fileStat: Stats,
): Promise<AgentTranscriptReadResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_READ_BYTES;
  if (fileStat.size > maxBytes) {
    transcriptCache.delete(path);
    return {
      entries: [],
      diagnostics: [
        {
          code: "transcript_too_large",
          severity: "error",
          message: `Transcript ${path} is larger than ${maxBytes} bytes.`,
        },
      ],
    };
  }

  const content = await readFile(path, "utf8");
  const result = parseTranscript(content);
  transcriptCache.set(path, {
    entries: result.entries,
    diagnostics: result.diagnostics,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  });
  // 返回浅拷贝数组（元素共享），调用方修改数组不会污染缓存。
  return { entries: [...result.entries], diagnostics: result.diagnostics };
}
