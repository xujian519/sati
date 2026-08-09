import { readFile, stat } from "node:fs/promises";
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
 * 解析结果缓存：以文件 mtime+size 做快速失效判断（stat 一次 syscall），
 * 命中时跳过整文件读取 + 逐行 JSON.parse。会话加载/翻页（readSessionMessages）
 * 高频调用，长会话每次全量重解析是主要开销。TTL 5s 兜底保证文件替换
 * （mtime 精度/同尺寸覆盖等边界）最迟 5s 内可见。缓存条目不可变：
 * 返回浅拷贝数组，调用方修改不影响缓存。
 */
const TRANSCRIPT_CACHE_TTL_MS = 5_000;
const TRANSCRIPT_CACHE_MAX = 32;

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

export async function readTranscript(
  path: string,
  options: ReadTranscriptOptions = {},
): Promise<AgentTranscriptReadResult> {
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

function parseTranscript(content: string): {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
} {
  const entries: AgentTranscriptEntry[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isTranscriptEntry(parsed)) {
        entries.push(parsed);
      } else {
        diagnostics.push({
          code: "transcript_entry_invalid",
          severity: "error",
          message: "Transcript entry has an invalid shape.",
          line: index + 1,
        });
      }
    } catch (error) {
      diagnostics.push({
        code: "transcript_line_invalid",
        severity: "error",
        message: error instanceof Error ? error.message : "Transcript line is not valid JSON.",
        line: index + 1,
      });
    }
  }

  entries.sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return left.createdAt.localeCompare(right.createdAt);
  });
  return { entries, diagnostics };
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
