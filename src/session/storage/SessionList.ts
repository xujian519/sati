import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { TtlCache } from "../../shared/ttl-cache.js";
import { readSessionLite, type SessionLiteFile } from "./SessionLiteReader.js";

const ALWAYS_ON_AUXILIARY_PATTERN = /^always-on-(discovery|workspace|report)[:\-]/;

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
    const lite = await readSessionLite(join(chatDir, name));
    if (!lite) {
      continue;
    }
    const sessionId = name.slice(0, -".jsonl".length);
    // 注意：不传 projectRoot，cwd 由调用方盖章（缓存快照不含 cwd）。
    const info = parseSessionInfoFromLite(sessionId, lite);
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
