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
 */

import type {
  CanonicalContentBlock,
  CanonicalMessage,
} from "../../model/index.js";
import { listProjectSessions, readTranscript, replayTranscriptEntries, findLastCompactBoundaryIndex, type SessionInfo } from "../../session/index.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";
import type {
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
} from "../client/protocol.js";
import type { WebMessage, WebMessageKind, WebMessageRole } from "../client/webMessage.js";

export type ReadWebSessionMessagesOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Override clock for deterministic tests. */
  now?: () => Date;
};

export async function readWebSessionMessages(
  input: WebReadSessionMessagesInput,
  options: ReadWebSessionMessagesOptions,
): Promise<WebReadSessionMessagesResult> {
  const sessionInfo = await locateSession(input.sessionKey, options);
  const transcriptPath = resolve(
    getPilotProjectChatDir(options.projectRoot, options.pilotHome),
    `${sanitizeSessionIdForPath(input.sessionKey)}.jsonl`,
  );
  const { entries } = await readTranscript(transcriptPath);
  const replay = replayTranscriptEntries(entries);
  const entryTimestamps = extractMessageTimestamps(entries);
  const allMessages = replay.messages.flatMap((message, index) =>
    flattenCanonicalMessage(message, {
      index,
      sessionKey: input.sessionKey,
      projectKey: input.projectKey,
      now: options.now,
      entryTimestamp: entryTimestamps[index],
    }),
  );

  const offset = parseCursor(input.cursor);
  const limit = input.limit ?? allMessages.length;
  const sliceEnd = limit === 0 ? allMessages.length : offset + limit;
  const slice = allMessages.slice(offset, sliceEnd);

  return {
    messages: slice,
    nextCursor:
      input.limit && offset + slice.length < allMessages.length
        ? String(offset + slice.length)
        : undefined,
    total: allMessages.length,
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
    },
  };
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
  return sessions.find(
    (session) => session.sessionId === sessionKey || session.sessionId === safeKey,
  );
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

type ProjectionContext = {
  index: number;
  sessionKey: string;
  projectKey?: string;
  now?: () => Date;
  /** Actual transcript entry timestamp — preferred over now(). */
  entryTimestamp?: string;
};

/**
 * Flatten a CanonicalMessage's content blocks into one or more WebMessages.
 * Adjacent text blocks within the same canonical message merge.
 */
export function flattenCanonicalMessage(
  message: CanonicalMessage,
  context: ProjectionContext,
): WebMessage[] {
  const stamp = context.entryTimestamp ?? (context.now ?? (() => new Date()))().toISOString();
  const out: WebMessage[] = [];
  const role: WebMessageRole = message.role === "user" ? "user" : "assistant";
  let textBuffer = "";

  const flushText = (): void => {
    if (!textBuffer) return;
    out.push({
      id: `${context.sessionKey}-msg-${context.index}-${out.length}`,
      sessionKey: context.sessionKey,
      projectKey: context.projectKey,
      createdAt: stamp,
      provider: "pilotdeck",
      role,
      kind: "text",
      text: textBuffer,
      source: "history",
    });
    textBuffer = "";
  };

  for (const block of message.content) {
    flushBlock(block, out, context, stamp, role, () => {
      flushText();
    }, (chunk) => {
      textBuffer += chunk;
    });
  }
  flushText();
  return out;
}

function flushBlock(
  block: CanonicalContentBlock,
  out: WebMessage[],
  context: ProjectionContext,
  stamp: string,
  role: WebMessageRole,
  flushText: () => void,
  appendText: (chunk: string) => void,
): void {
  switch (block.type) {
    case "text":
      appendText(block.text);
      return;
    case "thinking":
      flushText();
      out.push({
        id: `${context.sessionKey}-thinking-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "assistant",
        kind: "thinking",
        text: block.text,
        source: "history",
      });
      return;
    case "tool_call":
      flushText();
      out.push({
        id: `${context.sessionKey}-tool-${block.id}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_use",
        toolCallId: block.id,
        toolName: block.name,
        payload: block.input,
        source: "history",
      });
      return;
    case "tool_result": {
      flushText();
      const resultText = block.content.map((part) => part.text).join("");
      out.push({
        id: `${context.sessionKey}-tool-${block.toolCallId}-result`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ok: !block.isError,
        text: resultText,
        source: "history",
      });
      return;
    }
    case "tool_result_reference":
      flushText();
      out.push({
        id: `${context.sessionKey}-tool-${block.toolCallId}-result-ref`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ok: true,
        text: block.preview,
        payload: {
          path: block.path,
          originalBytes: block.originalBytes,
          hasMore: block.hasMore,
          mimeType: block.mimeType,
          reason: block.reason,
        },
        source: "history",
      });
      return;
    case "image":
    case "pdf":
    case "audio":
      flushText();
      const kind: WebMessageKind = "status";
      out.push({
        id: `${context.sessionKey}-attachment-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role,
        kind,
        text: `[${block.type} attachment]`,
        payload: { mimeType: block.mimeType, bytes: "bytes" in block ? block.bytes : undefined },
        source: "history",
      });
      return;
  }
}

/**
 * Mirror `replayTranscriptEntries` message-production order to extract
 * the original `createdAt` timestamp for each CanonicalMessage. The
 * returned array is parallel to `replay.messages`.
 */
function extractMessageTimestamps(entries: AgentTranscriptEntry[]): string[] {
  const lastBoundaryIndex = findLastCompactBoundaryIndex(entries);
  const completedTurnIds = new Set(
    entries.filter((e) => e.type === "turn_result").map((e) => e.turnId),
  );
  const timestamps: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const beforeBoundary = lastBoundaryIndex !== -1 && index < lastBoundaryIndex;

    switch (entry.type) {
      case "accepted_input":
        if (!beforeBoundary) {
          for (let i = 0; i < entry.messages.length; i += 1) {
            timestamps.push(entry.createdAt);
          }
        }
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        if (completedTurnIds.has(entry.turnId) && !beforeBoundary) {
          timestamps.push(entry.createdAt);
        }
        break;
    }
  }

  return timestamps;
}
