import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { TtlCache } from "../../shared/ttl-cache.js";
import { mergeMetadata } from "../metadata/SessionMetadataStore.js";
import type { SessionMetadataValue } from "../transcript/TranscriptEntry.js";
import { readSessionLite, SESSION_LITE_READ_BYTES, type SessionLiteFile } from "./SessionLiteReader.js";

const ALWAYS_ON_AUXILIARY_PATTERN = /^always-on-(discovery|workspace|report)[:\-]/;
/** 会话元数据兜底扫描的分块大小（避开把超大 JSONL 记录整行载入内存）。 */
const SESSION_METADATA_SCAN_CHUNK_BYTES = 64 * 1024;
/** 非 session_metadata 行超过该字节数即丢弃（如 base64 图片输入），继续向后找。 */
const MAX_SESSION_METADATA_LINE_BYTES = 128 * 1024;

/**
 * chatDir 扫描结果缓存：以目录文件快照做快速失效判断。
 * 列表变更（新建/删除会话）会改变文件名集合 → 快照不匹配 → 重新扫描；
 * 会话内容更新（活跃度/标题）文件名不变 → TTL 内返回缓存（5s 新鲜度）。
 * 侧栏每次加载/翻页因此省去对每个会话文件的 stat + head/tail 读取。
 *
 * 缓存条目为不可变快照：会话不含 cwd（调用方按各自语义盖章），
 * includeInternal 过滤在读取侧进行；scanChatDir 返回浅拷贝数组，
 * 调用方修改返回结果不会污染缓存。
 */
const CHAT_DIR_CACHE_TTL_MS = 5_000;
const CHAT_DIR_CACHE_MAX = 64;

type ChatDirCacheEntry = {
  /** 目录快照：排序后的 .jsonl 文件名。 */
  names: string[];
  sessions: SessionInfo[];
};

const chatDirCache = new TtlCache<string, ChatDirCacheEntry>({
  ttlMs: CHAT_DIR_CACHE_TTL_MS,
  maxSize: CHAT_DIR_CACHE_MAX,
});

function isInternalSession(sessionId: string): boolean {
  return ALWAYS_ON_AUXILIARY_PATTERN.test(sessionId);
}

export type SessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
  parentSessionId?: string;
  forkedFromTurnId?: string;
};

export type ListProjectSessionsOptions = {
  projectRoot: string;
  pilotHome: string;
  limit?: number;
  offset?: number;
  includeInternal?: boolean;
};

export async function listProjectSessions(options: ListProjectSessionsOptions): Promise<SessionInfo[]> {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const sessions = (await scanChatDir(chatDir)).filter(
    session => options.includeInternal || !isInternalSession(session.sessionId),
  );
  return paginateSessions(
    sessions.map(session => ({ ...session, cwd: options.projectRoot })),
    options.limit,
    options.offset,
  );
}

/** 带目录快照缓存的 chatDir 扫描。返回不含 cwd 的不可变快照（浅拷贝数组）。 */
async function scanChatDir(chatDir: string): Promise<SessionInfo[]> {
  const cached = chatDirCache.get(chatDir);
  if (cached) {
    // 快速失效判断：仅 readdir 一次（轻量），文件名集合未变则复用上次扫描结果，
    // 跳过对每个会话文件的 stat + head/tail 读取。
    let names: string[];
    try {
      names = (await readdir(chatDir)).filter(name => name.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
    if (arraysEqual(cached.names, names)) {
      return [...cached.sessions];
    }
  }

  const { sessions, names } = await scanChatDirUncached(chatDir);
  chatDirCache.set(chatDir, { names, sessions });
  return [...sessions];
}

async function scanChatDirUncached(chatDir: string): Promise<{ sessions: SessionInfo[]; names: string[] }> {
  let names: string[];
  try {
    names = await readdir(chatDir);
  } catch {
    return { sessions: [], names: [] };
  }
  const jsonlNames = names.filter(name => name.endsWith(".jsonl"));
  const sessions: SessionInfo[] = [];
  for (const name of jsonlNames) {
    const sessionId = name.slice(0, -".jsonl".length);
    // 注意：不传 projectRoot，cwd 由调用方盖章（缓存快照不含 cwd）。
    const info = await readSessionInfo(join(chatDir, name), sessionId);
    if (info) {
      sessions.push(info);
    }
  }

  sessions.sort((left, right) => right.lastModified - left.lastModified);
  return { sessions, names: jsonlNames.sort() };
}

function paginateSessions(sessions: SessionInfo[], limit?: number, offset?: number): SessionInfo[] {
  const off = Math.max(0, offset ?? 0);
  const lim = limit ?? sessions.length;
  return sessions.slice(off, lim === 0 ? undefined : off + lim);
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 会话列表条目的完整读取：fast path（head+tail 预览）→ tail 快照 → 全文件
 * 分块扫描兜底。大附件（base64 图片等）会把首个 JSONL 记录撑过 64KiB 预览
 * 窗口，fast path 丢 metadata 时用尾部 isSnapshot 快照或全文件扫描补齐，
 * 保证旧的 head 标题不会掩盖更新的超大尾部记录。
 */
export async function readSessionInfo(
  path: string,
  sessionId: string,
  projectRoot?: string,
): Promise<SessionInfo | null> {
  const lite = await readSessionLite(path);
  if (!lite) return null;

  const fastInfo = parseSessionInfoFromLite(sessionId, lite, projectRoot);
  if (fastInfo && lite.size <= SESSION_LITE_READ_BYTES) return fastInfo;
  const tailSnapshot = readLatestTailSnapshot(lite);
  if (tailSnapshot) {
    const snapshotInfo = parseSessionInfoFromMetadata(sessionId, lite, tailSnapshot, projectRoot);
    if (snapshotInfo) return mergeSessionInfo(fastInfo, snapshotInfo);
  }

  // 预览未含完整的最新 metadata 记录时，全文件分块扫描兜底。
  const metadata = await readLastSessionMetadata(path);
  const metadataInfo = metadata ? parseSessionInfoFromMetadata(sessionId, lite, metadata, projectRoot) : null;
  return mergeSessionInfo(fastInfo, metadataInfo);
}

function mergeSessionInfo(fastInfo: SessionInfo | null, metadataInfo: SessionInfo | null): SessionInfo | null {
  if (!metadataInfo) return fastInfo;
  if (!fastInfo) return metadataInfo;
  return {
    ...fastInfo,
    ...metadataInfo,
    firstPrompt: metadataInfo.firstPrompt ?? fastInfo.firstPrompt,
    createdAt: metadataInfo.createdAt ?? fastInfo.createdAt,
  };
}

function readLatestTailSnapshot(lite: SessionLiteFile): SessionMetadataValue | undefined {
  if (lite.size <= SESSION_LITE_READ_BYTES) {
    return undefined;
  }

  // tail 从任意字节偏移开始，首行可能是残缺的（只取该行之后）。
  // 之后的完整 metadata 记录必然更新。metadata 记录是增量 patch，
  // 只有 reappendTail() 写显式完整快照，普通尾部 patch 不能跳过标题恢复。
  let latestMetadata: SessionMetadataValue | undefined;
  const lines = lite.tail.split(/\r?\n/);
  // 首行通常残缺（tail 从任意字节偏移开始），但也可能恰为完整 metadata
  // 记录——能解析则不跳过，否则最新的快照记录会被静默丢弃。
  const startIndex = parseSessionMetadataLine(lines[0]!) !== undefined ? 0 : 1;
  for (const line of lines.slice(startIndex)) {
    if (!line.includes('"type":"session_metadata"')) continue;
    const metadata = parseSessionMetadataLine(line);
    if (!metadata) return undefined;
    latestMetadata = metadata;
  }
  if (
    latestMetadata?.isSnapshot === true &&
    (latestMetadata.title?.trim() ||
      latestMetadata.aiTitle?.trim() ||
      latestMetadata.lastPrompt?.trim() ||
      latestMetadata.firstPrompt?.trim())
  ) {
    return latestMetadata;
  }
  return undefined;
}

function parseSessionInfoFromMetadata(
  sessionId: string,
  lite: SessionLiteFile,
  metadata: SessionMetadataValue,
  projectRoot?: string,
): SessionInfo | null {
  const summary = metadata.title ?? metadata.aiTitle ?? metadata.lastPrompt ?? metadata.firstPrompt;
  if (!summary?.trim()) return null;
  const firstCreatedAt = firstJsonStringField(lite.head, "createdAt");
  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    customTitle: metadata.title,
    aiTitle: metadata.aiTitle,
    firstPrompt: metadata.firstPrompt,
    cwd: projectRoot,
    createdAt: firstCreatedAt ? Date.parse(firstCreatedAt) : undefined,
    tag: metadata.tag,
    parentSessionId: metadata.parentSessionId,
    forkedFromTurnId: metadata.forkedFromTurnId,
  };
}

/**
 * 只扫描严格 session_metadata 记录，同时避免把超大 JSONL 记录
 * （如 base64 图片输入）整行载入内存。非 metadata 行超过
 * MAX_SESSION_METADATA_LINE_BYTES 即丢弃继续向后扫。
 */
async function readLastSessionMetadata(path: string): Promise<SessionMetadataValue | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(SESSION_METADATA_SCAN_CHUNK_BYTES);
    let lastMetadata: SessionMetadataValue | undefined;
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;
    let lineTooLarge = false;
    let lineIsSessionMetadata = false;

    const append = (segment: Buffer): void => {
      if (segment.length === 0) return;
      lineBytes += segment.length;
      if (lineTooLarge) return;

      // 转录记录把 `type` 序列化在最前：行首缓冲前缀即可在超大行
      // 触发上限前识别出 metadata 记录（大 fork firstPrompt 也保留）。
      if (!lineIsSessionMetadata) {
        const prefix = Buffer.concat([...lineChunks, segment]).toString("utf8");
        lineIsSessionMetadata = prefix.includes('"type":"session_metadata"');
      }
      if (!lineIsSessionMetadata && lineBytes > MAX_SESSION_METADATA_LINE_BYTES) {
        lineChunks = [];
        lineTooLarge = true;
        return;
      }
      lineChunks.push(Buffer.from(segment));
    };

    const finishLine = (): void => {
      if (!lineTooLarge) {
        const metadata = parseSessionMetadataLine(Buffer.concat(lineChunks).toString("utf8").replace(/\r$/, ""));
        if (metadata) lastMetadata = mergeMetadata(lastMetadata ?? {}, metadata);
      }
      lineChunks = [];
      lineBytes = 0;
      lineTooLarge = false;
      lineIsSessionMetadata = false;
    };

    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      let start = 0;
      for (
        let newline = buffer.indexOf(0x0a, start);
        newline !== -1 && newline < bytesRead;
        newline = buffer.indexOf(0x0a, start)
      ) {
        append(buffer.subarray(start, newline));
        finishLine();
        start = newline + 1;
      }
      append(buffer.subarray(start, bytesRead));
    }
    if (lineBytes > 0 || lineChunks.length > 0) finishLine();
    return lastMetadata;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseSessionMetadataLine(line: string): SessionMetadataValue | undefined {
  if (!line.includes('"type":"session_metadata"')) return undefined;
  try {
    const entry = JSON.parse(line) as unknown;
    if (!isRecord(entry) || entry.type !== "session_metadata" || !isRecord(entry.metadata)) {
      return undefined;
    }
    const metadata = entry.metadata;
    const parsed: SessionMetadataValue = {};
    if (metadata.isSnapshot === true) {
      parsed.isSnapshot = true;
    }
    const stringFields = [
      "title",
      "aiTitle",
      "tag",
      "firstPrompt",
      "lastPrompt",
      "parentSessionId",
      "forkedFromTurnId",
    ] as const;
    for (const field of stringFields) {
      const value = stringValue(metadata[field]);
      if (value !== undefined) {
        parsed[field] = value;
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseSessionInfoFromLite(
  sessionId: string,
  lite: SessionLiteFile,
  projectRoot?: string,
): SessionInfo | null {
  const source = `${lite.head}\n${lite.tail}`;
  const customTitle = lastMetadataStringField(source, "title");
  const aiTitle = lastMetadataStringField(source, "aiTitle");
  const tag = lastMetadataStringField(source, "tag");
  const parentSessionId = lastMetadataStringField(source, "parentSessionId");
  const forkedFromTurnId = lastMetadataStringField(source, "forkedFromTurnId");
  const firstPrompt = firstAcceptedInputText(lite.head);
  const lastPrompt = lastAcceptedInputText(lite.tail) ?? firstPrompt;
  const summary = customTitle ?? aiTitle ?? lastPrompt;
  if (!summary) {
    return null;
  }

  const firstCreatedAt = firstJsonStringField(lite.head, "createdAt");
  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    customTitle,
    aiTitle,
    firstPrompt,
    cwd: projectRoot,
    tag,
    createdAt: firstCreatedAt ? Date.parse(firstCreatedAt) : undefined,
    parentSessionId,
    forkedFromTurnId,
  };
}

function firstAcceptedInputText(head: string): string | undefined {
  for (const line of head.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"')) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as {
        messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      const text = entry.messages?.flatMap(message => message.content ?? []).find(block => block.type === "text")?.text;
      if (text?.trim()) {
        return text.trim();
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function lastAcceptedInputText(tail: string): string | undefined {
  let last: string | undefined;
  for (const line of tail.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"')) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as {
        messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      const text = entry.messages?.flatMap(message => message.content ?? []).find(block => block.type === "text")?.text;
      if (text?.trim()) {
        last = text.trim();
      }
    } catch {
      // partial line at tail boundary — skip
    }
  }
  return last;
}

function firstJsonStringField(source: string, field: string): string | undefined {
  const match = source.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"])*)"`));
  return match?.[1] ? unescapeJsonString(match[1]) : undefined;
}

/**
 * Like scanning raw text for a JSON string field, but restricted to JSONL
 * lines whose `"type"` is `"session_metadata"`. The old approach scanned the
 * entire raw head+tail text for `"title"`, which would pick up stray `"title"`
 * keys from tool-call inputs, web-search results, or activity frames —
 * causing the sidebar to display an intermediate tool argument instead
 * of the actual session title.
 */
function lastMetadataStringField(source: string, field: string): string | undefined {
  const fieldRegex = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"])*)"`);
  let value: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('"session_metadata"')) continue;
    const match = line.match(fieldRegex);
    if (match?.[1]) {
      value = unescapeJsonString(match[1]);
    }
  }
  return value;
}

function unescapeJsonString(value: string): string {
  return JSON.parse(`"${value}"`) as string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

/** Options for listing sessions across all known projects. */
export type ListAllSessionsOptions = {
  pilotHome: string;
  limit?: number;
  offset?: number;
  includeInternal?: boolean;
};

/**
 * List sessions across **all** projects under `{pilotHome}/projects/`. Each
 * project directory is scanned for `.jsonl` files in its `chats/` subfolder.
 * Results are sorted by lastModified descending (most-recent first), then
 * paginated via `limit` / `offset`.
 */
export async function listAllSessions(options: ListAllSessionsOptions): Promise<SessionInfo[]> {
  const projectsDir = resolve(options.pilotHome, "projects");
  let projectIds: string[];
  try {
    projectIds = await readdir(projectsDir);
  } catch {
    return [];
  }

  const all: SessionInfo[] = [];
  for (const projectId of projectIds) {
    const chatDir = join(projectsDir, projectId, "chats");
    const sessions = (await scanChatDir(chatDir)).filter(
      session => options.includeInternal || !isInternalSession(session.sessionId),
    );
    for (const session of sessions) {
      all.push({ ...session, cwd: projectId });
    }
  }

  all.sort((left, right) => right.lastModified - left.lastModified);
  return paginateSessions(all, options.limit, options.offset);
}

/** Options for title-based session search. */
export type SearchSessionsByTitleOptions = {
  projectRoot: string;
  pilotHome: string;
  query: string;
  limit?: number;
  includeInternal?: boolean;
};

/**
 * Search sessions within a project by matching `query` (case-insensitive
 * substring) against `customTitle`, `aiTitle`, and `firstPrompt`. Returns
 * results sorted by lastModified descending.
 */
export async function searchSessionsByTitle(options: SearchSessionsByTitleOptions): Promise<SessionInfo[]> {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const all = (await scanChatDir(chatDir)).filter(
    session => options.includeInternal || !isInternalSession(session.sessionId),
  );

  const needle = options.query.toLowerCase();
  const results: SessionInfo[] = [];
  for (const info of all) {
    const haystack = [info.customTitle, info.aiTitle, info.firstPrompt].filter(Boolean).join(" ").toLowerCase();
    if (haystack.includes(needle)) {
      results.push({ ...info, cwd: options.projectRoot });
    }
  }

  return options.limit ? results.slice(0, options.limit) : results;
}
