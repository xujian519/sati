/**
 * Read a session's transcript and project it onto Web `WebMessage[]`.
 *
 * The Web UI cannot consume `CanonicalMessage[]` directly because the
 * shape leaks `tool_call_block` / `tool_result_block` / `thinking_block`
 * details that need merging. This reader is the Phase 2 contract:
 *
 *   sessionKey
 *     -> readTranscript(.jsonl)
 *     -> replayTranscriptEntries(...)
 *     -> CanonicalMessage[]
 *     -> WebMessage[]
 *
 * Pagination is offset-based (`cursor` is a stringified integer). We do
 * NOT slice individual content blocks within a message — paging cuts at
 * `WebMessage` boundaries.
 *
 * 拆出：webMessageFlatten.ts（CanonicalMessage → WebMessage 扁平化）、
 * injectWebMessages.ts（压缩边界 / file_artifacts / 错误 turn / agent 状态注入）。
 */

import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type CanonicalMessage } from "../../model/index.js";
import { listProjectSessions, readTranscript, type SessionInfo } from "../../session/index.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { collectShadowedEntryIds } from "../../session/transcript/TranscriptReplay.js";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";
import type { WebReadSessionMessagesInput, WebReadSessionMessagesResult } from "../client/protocol.js";
import type { WebMessage } from "../client/webMessage.js";
import { tokenUsageFromTranscript } from "./sessionTokenUsage.js";
import { flattenCanonicalMessage, shouldShowCompactReplacementInWeb } from "./webMessageFlatten.js";
import {
  compactBoundaryMetadata,
  injectAgentStatusMessages,
  injectErrorTurnMessages,
  injectFileArtifactMessages,
  insertCompactBoundaryMessages,
  type CompactBoundaryInfo,
} from "./injectWebMessages.js";

export type ReadWebSessionMessagesOptions = {
  projectRoot: string;
  pilotHome: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /** Override clock for deterministic tests. */
  now?: () => Date;
};

/**
 * P2-C 构建缓存：UI 轮询/翻页每次请求都走 extract+flatten+inject 全量重建
 * （长会话 O(N×M)，H5 卡点）。transcript 未变（mtime+size，与 P2-A 增量读取
 * 同校验）时直接 slice 命中。LRU 上限 32（多会话同时活跃）。
 * createIncompleteTurnStatusMessage 依赖当前时间 → 移出缓存每请求重建。
 */
const WEB_MESSAGES_CACHE_MAX = 32;

type WebMessagesCacheEntry = {
  mtimeMs: number;
  size: number;
  allMessages: WebMessage[];
  incompleteTurnIds: string[];
  /** tokenUsage 快照（与 allMessages 同批次构建）。命中路径展示与用量来自
   * 同一快照——消除「命中缓存后二次读文件」的双 stat TOCTOU（读到新文件、
   * 展示旧缓存的不一致）。依赖 maxContextTokens/maxOutputTokens，命中时须
   * 与构建时一致（下方两条键控字段）。 */
  tokenUsage: Record<string, unknown> | undefined;
  maxContextTokens?: number;
  maxOutputTokens?: number;
};

const webMessagesCache = new Map<string, WebMessagesCacheEntry>();

function touchWebMessagesCache(key: string, entry: WebMessagesCacheEntry): void {
  webMessagesCache.delete(key);
  webMessagesCache.set(key, entry);
  if (webMessagesCache.size > WEB_MESSAGES_CACHE_MAX) {
    const oldest = webMessagesCache.keys().next().value;
    if (oldest !== undefined) webMessagesCache.delete(oldest);
  }
}

export async function readWebSessionMessages(
  input: WebReadSessionMessagesInput,
  options: ReadWebSessionMessagesOptions,
): Promise<WebReadSessionMessagesResult> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const chatDir = getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const transcriptPath = resolveTranscriptPath(input, chatDir);
  const isBackgroundTask = isBackgroundTaskInput(input);
  const sessionInfo = isBackgroundTask
    ? undefined
    : await locateSession(input.sessionKey, {
        ...options,
        projectRoot: effectiveProjectRoot,
      });
  // P2-C 构建缓存：transcript 未变（mtime+size，与 P2-A 增量读取同校验）时
  // 直接 slice 命中，跳过 extract+flatten+inject 全量重建（H5 卡点）。
  let fileStat: Stats | undefined;
  try {
    fileStat = await stat(transcriptPath);
  } catch {
    fileStat = undefined; // ENOENT 等：走完整构建（readTranscript 给 missing 诊断）
  }
  const cached = fileStat ? webMessagesCache.get(transcriptPath) : undefined;

  let allMessages: WebMessage[];
  let incompleteTurnIds: string[];
  let tokenUsage: Record<string, unknown> | undefined;
  if (
    cached !== undefined &&
    cached.mtimeMs === fileStat!.mtimeMs &&
    cached.size === fileStat!.size &&
    cached.maxContextTokens === options.maxContextTokens &&
    cached.maxOutputTokens === options.maxOutputTokens
  ) {
    touchWebMessagesCache(transcriptPath, cached);
    allMessages = cached.allMessages;
    incompleteTurnIds = cached.incompleteTurnIds;
    tokenUsage = cached.tokenUsage; // 命中即 0 文件访问：展示与用量同快照（无 TOCTOU）
  } else {
    const read = await readTranscript(transcriptPath);
    const entries = read.entries;
    const webReplay = extractWebVisibleMessages(entries);
    const entryTimestamps = webReplay.timestamps;
    const entryIds = webReplay.entryIds;
    incompleteTurnIds = extractIncompleteTurnIds(entries);

    const flattenedPerMessage: WebMessage[][] = webReplay.messages.map((message, index) =>
      flattenCanonicalMessage(message, {
        index,
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        now: options.now,
        entryTimestamp: entryTimestamps[index],
        entryId: entryIds[index],
        forkUnsupportedContent: webReplay.forkUnsupportedContents[index],
      }),
    );

    // 压缩边界：在对应消息后插入 compact_boundary WebMessage，payload 内嵌
    // shadowedRanges 与该次压缩被遮蔽的原文（WebMessage 级扁平化，复用同一
    // 投影），前端展开压缩历史无需额外请求。
    insertCompactBoundaryMessages(input, flattenedPerMessage, webReplay.compactBoundaries, entries, options);

    allMessages = flattenedPerMessage.flat();

    attachSubagentIds(entries, allMessages);
    if (resolve(effectiveProjectRoot) !== resolve(options.pilotHome)) {
      injectFileArtifactMessages(entries, allMessages, input.sessionKey, input.projectKey);
    }
    injectAgentStatusMessages(entries, allMessages, input.sessionKey, input.projectKey);
    injectErrorTurnMessages(entries, allMessages, input.sessionKey, input.projectKey);
    tokenUsage = tokenUsageFromTranscript(entries, options);
    // 注：incomplete turn status 依赖当前时间，不入缓存——统一返回路径重建。
    if (fileStat) {
      // 写缓存前复验：read 完成后文件未再变化才落缓存（消除 stat→read 窗口
      // 的「标记旧 mtime/size、内容新」双 stat TOCTOU——否则缓存标记与内容
      // 不一致，命中时展示旧快照而 tokenUsage 来自新文件）。
      const afterStat = await stat(transcriptPath).catch(() => undefined);
      if (afterStat !== undefined && afterStat.mtimeMs === fileStat.mtimeMs && afterStat.size === fileStat.size) {
        touchWebMessagesCache(transcriptPath, {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          allMessages,
          incompleteTurnIds,
          tokenUsage,
          maxContextTokens: options.maxContextTokens,
          maxOutputTokens: options.maxOutputTokens,
        });
      }
    }
  }

  // 统一返回路径：status 每请求重建（时间戳 = 当前时间）；只出现在最后一页
  // （slice 到达 allMessages 末尾时附加）。
  const status =
    incompleteTurnIds.length > 0 ? createIncompleteTurnStatusMessage(input, incompleteTurnIds, options) : undefined;
  const total = allMessages.length + (status ? 1 : 0);
  const offset = parseCursor(input.cursor);
  const limit = input.limit ?? allMessages.length;
  const sliceEnd = limit === 0 ? allMessages.length : offset + limit;
  const slice = allMessages.slice(offset, sliceEnd);
  const messages = status !== undefined && sliceEnd >= allMessages.length ? [...slice, status] : slice;

  return {
    messages,
    nextCursor: input.limit && offset + messages.length < total ? String(offset + messages.length) : undefined,
    total,
    tokenUsage,
    session: {
      sessionId: sessionInfo?.sessionId ?? input.sessionKey,
      sessionKey: input.sessionKey,
      summary: sessionInfo?.summary ?? input.sessionKey,
      lastModified: sessionInfo?.lastModified ?? 0,
      fileSize: sessionInfo?.fileSize,
      customTitle: sessionInfo?.customTitle,
      aiTitle: sessionInfo?.aiTitle,
      firstPrompt: sessionInfo?.firstPrompt,
      cwd: sessionInfo?.cwd,
      tag: sessionInfo?.tag,
      createdAt: sessionInfo?.createdAt,
      ...(isBackgroundTask ? { sessionKind: "background_task" as const } : {}),
      parentSessionId: input.parentSessionId ?? sessionInfo?.parentSessionId,
      relativeTranscriptPath: input.relativeTranscriptPath,
      forkedFromTurnId: sessionInfo?.forkedFromTurnId,
    },
  };
}

/**
 * Read a subagent's sidechain transcript and project it onto WebMessage[].
 * Locates the sidechain JSONL by deriving the default path from the parent
 * session transcript path + subagentId.
 */
export async function readSubagentWebMessages(
  input: {
    sessionKey: string;
    subagentId: string;
    projectKey?: string;
    sessionKind?: "background_task";
    parentSessionId?: string;
    relativeTranscriptPath?: string;
  },
  options: ReadWebSessionMessagesOptions,
): Promise<{ messages: WebMessage[]; total: number }> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const chatDir = getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const parentTranscriptPath = resolveTranscriptPath(input, chatDir);

  const { entries: parentEntries } = await readTranscript(parentTranscriptPath);
  let sidechainRelative: string | undefined;
  for (const entry of parentEntries) {
    if (entry.type === "subagent_started" && entry.subagentId === input.subagentId) {
      sidechainRelative = entry.transcriptRelativePath;
      break;
    }
  }

  if (!sidechainRelative) {
    return { messages: [], total: 0 };
  }

  const sidechainPath = resolveRelativeTranscriptPath(sidechainRelative, dirname(parentTranscriptPath), chatDir);
  const { entries } = await readTranscript(sidechainPath);
  const webReplay = extractSubagentExecutionMessages(entries);

  const flattenedPerMessage: WebMessage[][] = webReplay.messages
    .filter(message => !message.metadata?.synthetic)
    .map((message, index) =>
      flattenCanonicalMessage(message, {
        index,
        sessionKey: `${input.sessionKey}::sub::${input.subagentId}`,
        projectKey: input.projectKey,
        now: options.now,
        entryTimestamp: webReplay.timestamps[index],
      }),
    );
  insertCompactBoundaryMessages(input, flattenedPerMessage, webReplay.compactBoundaries, entries, options);
  const allMessages: WebMessage[] = flattenedPerMessage.flat();

  return { messages: allMessages, total: allMessages.length };
}

function isBackgroundTaskInput(input: {
  sessionKind?: string;
  relativeTranscriptPath?: string;
}): input is { sessionKind: "background_task"; relativeTranscriptPath: string } {
  return (
    input.sessionKind === "background_task" &&
    typeof input.relativeTranscriptPath === "string" &&
    input.relativeTranscriptPath.length > 0
  );
}

function resolveTranscriptPath(
  input: {
    sessionKey: string;
    sessionKind?: string;
    relativeTranscriptPath?: string;
  },
  chatDir: string,
): string {
  if (isBackgroundTaskInput(input)) {
    return resolveRelativeTranscriptPath(input.relativeTranscriptPath, chatDir, chatDir);
  }
  return resolve(chatDir, `${sanitizeSessionIdForPath(input.sessionKey)}.jsonl`);
}

function resolveRelativeTranscriptPath(path: string, baseDir: string, allowedRoot: string): string {
  if (!path || isAbsolute(path)) {
    throw new Error("relativeTranscriptPath must be a relative path.");
  }
  const candidate = resolve(baseDir, path);
  if (!isWithinDirectory(allowedRoot, candidate) || !candidate.endsWith(".jsonl")) {
    throw new Error("relativeTranscriptPath points outside the project transcript directory.");
  }
  return candidate;
}

function isWithinDirectory(parentDir: string, candidatePath: string): boolean {
  const rel = relative(parentDir, candidatePath);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function createIncompleteTurnStatusMessage(
  input: WebReadSessionMessagesInput,
  turnIds: string[],
  options: ReadWebSessionMessagesOptions,
): WebMessage {
  const stamp = (options.now ?? (() => new Date()))().toISOString();
  return {
    id: `${input.sessionKey}-incomplete-turn-status-${turnIds.join("-")}`,
    sessionKey: input.sessionKey,
    projectKey: input.projectKey,
    createdAt: stamp,
    provider: "sati",
    role: "system",
    kind: "status",
    text: "上次运行未正常结束或已中断，已恢复当时产生的工具调用和输出。",
    payload: { incompleteTurnIds: turnIds },
    source: "history",
  };
}

function extractIncompleteTurnIds(entries: AgentTranscriptEntry[]): string[] {
  const completedTurnIds = new Set(entries.filter(entry => entry.type === "turn_result").map(entry => entry.turnId));
  const incompleteTurnIds = new Set<string>();
  for (const entry of entries) {
    if (
      (entry.type === "assistant_message" ||
        entry.type === "tool_result_message" ||
        entry.type === "durable_message") &&
      !completedTurnIds.has(entry.turnId)
    ) {
      incompleteTurnIds.add(entry.turnId);
    }
  }
  return [...incompleteTurnIds];
}

async function locateSession(
  sessionKey: string,
  options: ReadWebSessionMessagesOptions,
): Promise<SessionInfo | undefined> {
  const sessions = await listProjectSessions({
    projectRoot: options.projectRoot,
    pilotHome: options.pilotHome,
  });
  // sessionId in SessionInfo is the on-disk filename (already sanitized);
  // the incoming sessionKey may still be the raw form (e.g. tui:project=/foo:default).
  // Compare against the sanitized form so locating works for both shapes.
  const safeKey = sanitizeSessionIdForPath(sessionKey);
  return sessions.find(session => session.sessionId === sessionKey || session.sessionId === safeKey);
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function extractWebVisibleMessages(entries: AgentTranscriptEntry[]): {
  messages: CanonicalMessage[];
  timestamps: string[];
  entryIds: Array<string | undefined>;
  forkUnsupportedContents: boolean[];
  compactBoundaries: CompactBoundaryInfo[];
} {
  const messages: CanonicalMessage[] = [];
  const timestamps: string[] = [];
  const entryIds: Array<string | undefined> = [];
  const forkUnsupportedContents: boolean[] = [];
  const compactBoundaries: CompactBoundaryInfo[] = [];
  // turn_rewrite 遮蔽：被声明的条目（编辑/重新生成前的旧消息）不出现在 Web 投影。
  const shadowedEntryIds = collectShadowedEntryIds(entries);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const isShadowed = entry.entryId !== undefined && shadowedEntryIds.has(entry.entryId);

    switch (entry.type) {
      case "accepted_input":
        if (isShadowed) {
          break;
        }
        {
          const entryForkUnsupported = entry.messages.some(message =>
            message.content.some(block => block.type !== "text"),
          );
          for (const message of entry.messages) {
            if (message.metadata?.synthetic) {
              continue;
            }
            if (!shouldShowCompactReplacementInWeb(message)) {
              continue;
            }
            messages.push(cloneMessage(message));
            timestamps.push(entry.createdAt);
            entryIds.push(entry.entryId);
            forkUnsupportedContents.push(entryForkUnsupported);
          }
        }
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        if (isShadowed) {
          break;
        }
        if (entry.message.metadata?.synthetic) {
          break;
        }
        if (!shouldShowCompactReplacementInWeb(entry.message)) {
          break;
        }
        messages.push(cloneMessage(entry.message));
        timestamps.push(entry.createdAt);
        entryIds.push(entry.entryId);
        forkUnsupportedContents.push(false);
        break;
      case "control_boundary": {
        if (entry.boundary && entry.boundary.kind === "compact") {
          compactBoundaries.push({
            insertAfterMessageIndex: messages.length - 1,
            timestamp: entry.createdAt,
            metadata: compactBoundaryMetadata(entry),
            boundaryIndex: index,
          });
        }
        break;
      }
    }
  }

  return { messages, timestamps, entryIds, forkUnsupportedContents, compactBoundaries };
}

function extractSubagentExecutionMessages(entries: AgentTranscriptEntry[]): {
  messages: CanonicalMessage[];
  timestamps: string[];
  compactBoundaries: CompactBoundaryInfo[];
} {
  const messages: CanonicalMessage[] = [];
  const timestamps: string[] = [];
  const compactBoundaries: CompactBoundaryInfo[] = [];
  let sawExecutionMessage = false;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    switch (entry.type) {
      case "accepted_input":
        // Sidechain accepted_input is the fork prelude: parent assistant
        // context + fork directive. It is model input, not subagent output.
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        sawExecutionMessage = true;
        if (entry.message.metadata?.synthetic || !shouldShowCompactReplacementInWeb(entry.message)) {
          break;
        }
        messages.push(cloneMessage(entry.message));
        timestamps.push(entry.createdAt);
        break;
      case "control_boundary": {
        if (sawExecutionMessage && entry.boundary && entry.boundary.kind === "compact") {
          compactBoundaries.push({
            insertAfterMessageIndex: messages.length - 1,
            timestamp: entry.createdAt,
            metadata: compactBoundaryMetadata(entry),
            boundaryIndex: index,
          });
        }
        break;
      }
    }
  }

  return { messages, timestamps, compactBoundaries };
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return JSON.parse(JSON.stringify(message)) as CanonicalMessage;
}

/**
 * Correlate `subagent_started` transcript entries with their parent `tool_use`
 * (agent/Task) WebMessages by matching order within entries, then stamp
 * `subagentId` onto the WebMessage so the frontend can link to the sidechain.
 */
function attachSubagentIds(entries: AgentTranscriptEntry[], allMessages: WebMessage[]): void {
  const subagentQueue: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === "subagent_started") {
      subagentQueue.push(entry.subagentId);
    }
  }
  if (subagentQueue.length === 0) return;

  let qi = 0;
  for (const msg of allMessages) {
    if (qi >= subagentQueue.length) break;
    if (msg.kind !== "tool_use") continue;
    const name = String(msg.toolName ?? "").toLowerCase();
    if (name !== "agent" && name !== "task") continue;
    msg.subagentId = subagentQueue[qi];
    qi += 1;
  }
}
