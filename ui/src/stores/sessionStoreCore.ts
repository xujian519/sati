/**
 * Session store core: slot/types definition plus the pure merge, dedup and
 * fetch-URL helpers shared by every action factory.
 *
 * Extracted verbatim from `useSessionStore.ts` (sweep B1.1). The hook and all
 * action factories import from this module so the per-session slot shape and
 * the merged-projection semantics have exactly one definition.
 */

import type { SessionProvider } from "../types/app";
import { readAgentStatusErrorFromResponse } from "../utils/api";

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | "text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "stream_delta"
  | "stream_end"
  | "error"
  | "complete"
  | "status"
  | "permission_request"
  | "permission_cancelled"
  | "session_created"
  | "interactive_prompt"
  | "task_notification"
  | "interrupted"
  | "compact_boundary"
  | "agent_activity"
  | "agent_activity_summary"
  | "file_artifacts";

export interface CompactProgress {
  level: number;
  stage: string;
  label: string;
  state: "started" | "running" | "failed" | "cancelled" | "completed";
  pre_tokens?: number;
  reason?: string;
  /** Correlates the in-flight progress with the terminal compact_boundary message. */
  compaction_id?: string;
}

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: SessionProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: "user" | "assistant";
  content?: string;
  contentI18n?: { key: string; params?: Record<string, unknown> };
  userHint?: string;
  userHintI18n?: { key: string; params?: Record<string, unknown> };
  images?: string[];
  attachments?: Array<{
    kind?: "file" | "document-selection";
    name: string;
    path?: string;
    size?: number;
    mimeType?: string;
    fileName?: string;
    filePath?: string;
    source?: "pdf" | "office-pdf";
    pageNumbers?: number[];
    selectedText?: string;
    surroundingText?: string;
    occurrenceIndex?: number | null;
    createdAt?: string;
    truncated?: boolean;
  }>;
  artifacts?: Array<{
    id: string;
    name: string;
    path: string;
    operation: "created" | "updated";
    source: "tool" | "workspace_diff";
    status: "complete" | "incomplete";
    size: number;
    sha256: string;
    mimeType?: string;
    createdAt: string;
  }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  /**
   * Inline image payloads attached to a `tool_result` frame (e.g. `read_file`
   * on a PNG). Object shape with `data` (data URL) and optional `mimeType` —
   * distinct from `images?: string[]` above, which carries user-message
   * upload data URLs. The bridge wraps gateway base64 as data URLs upstream
   * so the UI can drop these straight into `<img src>` without re-parsing.
   */
  toolResultImages?: Array<{ data: string; mimeType?: string; name?: string }>;
  isError?: boolean;
  /**
   * `SatiToolErrorCode` from the gateway when `kind === 'tool_result'`
   * and `isError === true` — flat on the frame because the bridge merges
   * `tool_call_finished.errorCode` here verbatim. See
   * `sati-bridge.js#tool_call_finished` and `chatPermissions.ts`.
   */
  errorCode?: string;
  /**
   * 工具返回的结构化 data（经 bridge `tool_call_finished` 透传，如
   * `document_style_panel` 的 { kind, htmlPath, style }）。
   */
  payload?: unknown;
  resultPath?: string;
  text?: string;
  reasoningContent?: string;
  tokens?: number;
  canInterrupt?: boolean;
  compactProgress?: CompactProgress;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  /**
   * `permission_request` 帧的发起者归属：子代理 fork 内的工具调用才有
   * （网关 `permission_request.origin` 经 bridge 透传）。主代理自身请求不带。
   */
  origin?: { kind: string; subagentId: string; subagentType?: string };
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentId?: string;
  /** `subagent_link` 帧透传的关联键（toolCallId）与子代理类型。 */
  toolCallId?: string;
  subagentType?: string;
  isSubagentDetail?: boolean;
  subagentTools?: unknown[];
  taskId?: string;
  outputFile?: string;
  taskResult?: string;
  trigger?: string;
  /** Stable identity shared by live and persisted representations of a compaction pass. */
  compactionId?: string;
  preTokens?: number;
  postTokens?: number;
  messagesSummarized?: number;
  compactLevel?: number;
  compactStage?: string;
  compactStageLabel?: string;
  /** 压缩终态（实时帧顶层字段）；历史投影改从 compactMetadata.status 读。 */
  compactState?: string;
  compactMetadata?: unknown;
  runId?: string;
  activityId?: string;
  phase?: string;
  state?: string;
  title?: string;
  detail?: string;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
  severity?: string;
  toolCallCount?: number;
  toolErrorCount?: number;
  ragSearchCount?: number;
  compactCount?: number;
  editedFileCount?: number;
  exploredFileCount?: number;
  commandCount?: number;
  subagentCount?: number;
  thinkingCount?: number;
  otherToolCount?: number;
  keySteps?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  /** Transcript entry id for history fork targeting. */
  entryId?: string;
  /** True when the corresponding transcript entry has non-text prefill content. */
  forkUnsupportedContent?: boolean;
  forkUnsupportedReason?: string;
  // Streaming-only: id of slot.serverMessages tail at the moment the
  // streaming row was created. computeMerged uses this for an id-based
  // same-turn-snapshot test instead of a timestamp window.
  serverTailIdAtStart?: string;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = "idle" | "loading" | "streaming" | "error";

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  activityMessages: NormalizedMessage[];
  subagentDetailMessages: Map<string, NormalizedMessage[]>;
  /** toolCallId → { subagentId, subagentType } links from bridge subagent_link frames */
  subagentLinks: Map<string, { subagentId: string; subagentType: string }>;
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  lastError: string | null;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];

export function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    activityMessages: EMPTY,
    subagentDetailMessages: new Map(),
    subagentLinks: new Map(),
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: "idle",
    fetchedAt: 0,
    lastError: null,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
  };
}

function normalizeRealtimeText(value?: string): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function parseTimestampMs(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isConfirmedUserMessageDuplicate(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  if (realtimeMessage.kind !== "text" || realtimeMessage.role !== "user" || !realtimeMessage.id.startsWith("local_")) {
    return false;
  }

  const realtimeText = normalizeRealtimeText(realtimeMessage.content);
  if (!realtimeText) return false;

  const realtimeTimestamp = parseTimestampMs(realtimeMessage.timestamp);

  return serverMessages.some(serverMessage => {
    if (serverMessage.kind !== "text" || serverMessage.role !== "user") {
      return false;
    }

    if (normalizeRealtimeText(serverMessage.content) !== realtimeText) {
      return false;
    }

    if (realtimeTimestamp == null) {
      return true;
    }

    const serverTimestamp = parseTimestampMs(serverMessage.timestamp);
    if (serverTimestamp == null) {
      return true;
    }

    return Math.abs(serverTimestamp - realtimeTimestamp) <= 10_000;
  });
}

/**
 * The backend pushes a synthetic `interrupted` notice the moment abort fires

 * "[Request interrupted by user]" entry into the JSONL during the next user
 * turn. Once that JSONL entry is replayed via the server, drop the locally
 * pushed one to avoid stacking two dividers in the conversation.
 */
function isLocalInterruptDuplicate(realtimeMessage: NormalizedMessage, serverMessages: NormalizedMessage[]): boolean {
  if (realtimeMessage.kind !== "interrupted" || !realtimeMessage.id.startsWith("local_interrupt_")) {
    return false;
  }

  const realtimeTimestamp = parseTimestampMs(realtimeMessage.timestamp);

  return serverMessages.some(serverMessage => {
    if (serverMessage.kind !== "interrupted") return false;
    if (realtimeTimestamp == null) return true;
    const serverTimestamp = parseTimestampMs(serverMessage.timestamp);
    if (serverTimestamp == null) return true;
    // Be generous on the window — the JSONL timestamp is when the SDK wrote
    // it on the next turn, which can be many minutes after the actual abort.
    return Math.abs(serverTimestamp - realtimeTimestamp) <= 30 * 60_000;
  });
}

// NOTE: isLocalFinalizedDuplicate was removed because it prematurely filtered
// finalized thinking/text messages when ANY server data existed (even from
// prior turns). The refreshFromServer cleanup already removes non-streaming
// realtime messages once the server commits the current turn's data.

function hasEquivalentServerMessage(realtimeMessage: NormalizedMessage, serverMessages: NormalizedMessage[]): boolean {
  const realtimeText = normalizeRealtimeText(realtimeMessage.content);
  if (!realtimeText) return false;

  let candidates = serverMessages;
  if (realtimeMessage.serverTailIdAtStart) {
    const tailIndex = serverMessages.findIndex(message => message.id === realtimeMessage.serverTailIdAtStart);
    if (tailIndex < 0) return false;
    candidates = serverMessages.slice(tailIndex + 1);
  } else {
    let lastUserIndex = -1;
    for (let index = serverMessages.length - 1; index >= 0; index -= 1) {
      const message = serverMessages[index];
      if (message.kind === "text" && message.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex >= 0) {
      candidates = serverMessages.slice(lastUserIndex + 1);
    }
  }

  return candidates.some(serverMessage => {
    if (serverMessage.kind !== realtimeMessage.kind) return false;
    if (serverMessage.role !== realtimeMessage.role) return false;
    return normalizeRealtimeText(serverMessage.content) === realtimeText;
  });
}

function hasSameTurnServerFinalMessage(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  if (
    realtimeMessage.isFinal !== true ||
    (realtimeMessage.kind !== "text" && realtimeMessage.kind !== "thinking") ||
    !realtimeMessage.serverTailIdAtStart
  ) {
    return false;
  }

  const tailIndex = serverMessages.findIndex(message => message.id === realtimeMessage.serverTailIdAtStart);
  if (tailIndex < 0) return false;
  const realtimeTimestamp = parseTimestampMs(realtimeMessage.timestamp);
  if (realtimeTimestamp == null) return false;
  const realtimeText = normalizeRealtimeText(realtimeMessage.content);
  if (!realtimeText) return false;

  return serverMessages.slice(tailIndex + 1).some(serverMessage => {
    if (serverMessage.kind !== realtimeMessage.kind) return false;
    if (serverMessage.role !== realtimeMessage.role) return false;
    if (realtimeMessage.runId != null && serverMessage.runId != null && serverMessage.runId !== realtimeMessage.runId) {
      return false;
    }
    const serverTimestamp = parseTimestampMs(serverMessage.timestamp);
    if (serverTimestamp == null) return false;
    if (serverTimestamp < realtimeTimestamp) return false;
    return normalizeRealtimeText(serverMessage.content) === realtimeText;
  });
}

export function shouldKeepRealtimeAfterServerRefresh(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  if (realtimeMessage.id.startsWith("__streaming_")) {
    return true;
  }

  if (realtimeMessage.isFinal === true && (realtimeMessage.kind === "text" || realtimeMessage.kind === "thinking")) {
    if (hasSameTurnServerFinalMessage(realtimeMessage, serverMessages)) {
      return false;
    }
    return !hasEquivalentServerMessage(realtimeMessage, serverMessages);
  }

  return false;
}

/**
 * Compute merged messages: server + realtime, deduped by id.
 * Server messages take priority (they're the persisted source of truth).
 * Realtime messages that aren't yet in server stay (in-flight streaming).
 */
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return server;
  }
  if (server.length === 0) return realtime;
  const serverIds = new Set(server.map(m => m.id));
  const serverToolIds = new Set(server.filter(m => m.kind === "tool_use" && m.toolId).map(m => m.toolId!));
  const extra = realtime.filter(message => {
    if (serverIds.has(message.id)) return false;
    if (isConfirmedUserMessageDuplicate(message, server)) return false;
    if (isLocalInterruptDuplicate(message, server)) return false;
    if (hasSameTurnServerFinalMessage(message, server)) return false;
    // Dedup tool_use by toolId (invocation ID) — the message envelope ID
    // may differ between WebSocket replay and server-persisted copy, but
    // the underlying tool invocation is the same.
    if (message.kind === "tool_use" && message.toolId && serverToolIds.has(message.toolId)) return false;
    return true;
  });
  if (extra.length === 0) return server;

  // Structural dedup: if there's an active __streaming_ message in extras
  // AND the server's last message is an assistant text whose id is NEW
  // (different from the id captured when streaming started), the server
  // wrote a mid-stream snapshot of the in-progress turn. Drop the server
  // snapshot in favor of the live streaming version.
  //
  // We compare ids (not timestamps) so the test is immune to NTP drift /
  // burst-turn scenarios where the previous turn's assistant message
  // finished writing within milliseconds of the next turn's first
  // stream_delta — a timestamp window can't distinguish those cases,
  // but an id comparison can: the previous turn's tail id was already
  // captured into `serverTailIdAtStart`, so a `lastServer.id ===
  // streamMsg.serverTailIdAtStart` match means "still the same tail
  // that was there at turn start" → don't dedup.
  const streamIdx = extra.findIndex(m => m.id.startsWith("__streaming_"));
  if (streamIdx >= 0 && server.length > 0) {
    const lastServer = server[server.length - 1];
    const streamMsg = extra[streamIdx];
    const isAssistantText = lastServer.kind === "text" && lastServer.role === "assistant";
    const tailIdChanged =
      streamMsg.serverTailIdAtStart !== undefined && lastServer.id !== streamMsg.serverTailIdAtStart;
    if (isAssistantText && tailIdChanged) {
      return [...server.slice(0, -1), ...extra];
    }
  }

  const result = [...server, ...extra];
  return result;
}

function getUpsertKey(message: NormalizedMessage): string {
  if ((message.kind === "tool_use" || message.kind === "tool_result") && message.toolId) {
    return `${message.id}::${message.kind}::${message.toolId}`;
  }
  return message.id;
}

function isCompatibleRealtimeTextRun(a: NormalizedMessage, b: NormalizedMessage): boolean {
  if (a.runId != null && b.runId != null) return a.runId === b.runId;
  const hasActiveStream = a.kind === "stream_delta" || b.kind === "stream_delta";
  if (!hasActiveStream) return false;
  const aTime = parseTimestampMs(a.timestamp);
  const bTime = parseTimestampMs(b.timestamp);
  if (aTime == null || bTime == null) return false;
  return Math.abs(aTime - bTime) <= 10_000;
}

function findDuplicateAssistantRealtimeTextIndex(messages: NormalizedMessage[], incoming: NormalizedMessage): number {
  if (incoming.kind !== "text" || incoming.role !== "assistant") return -1;
  const incomingText = normalizeRealtimeText(incoming.content);
  if (!incomingText) return -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const existing = messages[index];
    const isAssistantText = existing.kind === "text" && existing.role === "assistant";
    const isActiveAssistantStream =
      existing.kind === "stream_delta" && String(existing.id || "").startsWith("__streaming_");
    if (!isAssistantText && !isActiveAssistantStream) continue;
    if (!isCompatibleRealtimeTextRun(existing, incoming)) continue;
    if (normalizeRealtimeText(existing.content) !== incomingText) continue;
    return index;
  }

  return -1;
}

export function upsertRealtimeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  if (incoming.length === 0) return existing;
  const updated = [...existing];
  const indexByKey = new Map(updated.map((message, index) => [getUpsertKey(message), index]));
  for (const message of incoming) {
    if (message.kind === "tool_result" && message.toolId && message.resultPath) {
      const existingToolResultIndex = findLatestToolResultIndex(updated, message.toolId);
      if (existingToolResultIndex >= 0) {
        updated[existingToolResultIndex] = {
          ...updated[existingToolResultIndex],
          resultPath: message.resultPath,
        };
        continue;
      }
    }
    const duplicateAssistantTextIndex = findDuplicateAssistantRealtimeTextIndex(updated, message);
    if (duplicateAssistantTextIndex >= 0) {
      const previousKey = getUpsertKey(updated[duplicateAssistantTextIndex]);
      updated[duplicateAssistantTextIndex] = {
        ...message,
        serverTailIdAtStart: message.serverTailIdAtStart ?? updated[duplicateAssistantTextIndex].serverTailIdAtStart,
      };
      indexByKey.delete(previousKey);
      indexByKey.set(getUpsertKey(message), duplicateAssistantTextIndex);
      continue;
    }
    const key = getUpsertKey(message);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, updated.length);
      updated.push(message);
    } else {
      updated[existingIndex] = message;
    }
  }
  return updated;
}

function findLatestToolResultIndex(messages: NormalizedMessage[], toolId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind === "tool_result" && message.toolId === toolId) {
      return index;
    }
  }
  return -1;
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
export function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

export function forceRecomputeMerged(slot: SessionSlot): void {
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
}

export function streamingKey(sessionId: string, runId?: string): string {
  return runId ? `${sessionId}_${runId}` : sessionId;
}

export type SessionMessagesQuery = {
  provider?: SessionProvider;
  projectName?: string;
  projectPath?: string;
  sessionKind?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
};

export function appendSessionQueryParams(params: URLSearchParams, opts: SessionMessagesQuery): void {
  if (opts.provider) params.append("provider", opts.provider);
  if (opts.projectName) params.append("projectName", opts.projectName);
  if (opts.projectPath) params.append("projectPath", opts.projectPath);
  if (opts.sessionKind) params.append("sessionKind", opts.sessionKind);
  if (opts.parentSessionId) params.append("parentSessionId", opts.parentSessionId);
  if (opts.relativeTranscriptPath) {
    params.append("relativeTranscriptPath", opts.relativeTranscriptPath);
  }
}

export function buildMessagesUrl(sessionId: string, params: URLSearchParams): string {
  const qs = params.toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ""}`;
}

/** Throw a normalized session-load error when the response is not ok (shared by fetch/fetchMore/refresh). */
export async function ensureMessagesResponseOk(response: Response, action: "load" | "refresh"): Promise<void> {
  if (response.ok) return;
  const statusError = await readAgentStatusErrorFromResponse(response, {
    event: "web_http_request_failed",
    code: "session_messages_load_failed",
    message: `Unable to ${action} conversation messages (HTTP ${response.status}).`,
    scope: "session",
  });
  throw new Error(statusError.message);
}

export function getFinalizedSubagentThinkingId(sessionId: string, subagentId: string, timestamp?: string): string {
  const timestampSuffix = Date.parse(String(timestamp || "")) || Date.now();
  return `subagent_thinking_${sessionId}_${subagentId}_${timestampSuffix}`;
}

/**
 * Patch a single streaming row in `slot.merged` without recomputing the full list.
 * Returns true when the merged row was updated in place.
 */
export function patchMergedStreamingMessage(
  slot: SessionSlot,
  streamId: string,
  content: string,
  msgProvider?: SessionProvider,
): boolean {
  const mergedIdx = slot.merged.findIndex(message => message.id === streamId);
  if (mergedIdx < 0) {
    return false;
  }

  const existing = slot.merged[mergedIdx];
  if (existing.content === content && (msgProvider == null || existing.provider === msgProvider)) {
    return true;
  }

  slot.merged[mergedIdx] = {
    ...existing,
    content,
    ...(msgProvider != null ? { provider: msgProvider } : {}),
  };
  slot.merged = slot.merged.slice();
  return true;
}

export type RafScheduler = {
  schedule: (sessionId: string) => void;
  cancelAll: () => void;
};

/**
 * Coalesce per-session store notifications to one React update per animation frame.
 */
export function createRafNotifyScheduler(
  isActiveSession: (sessionId: string) => boolean,
  onNotify: () => void,
  scheduleFrame: (callback: () => void) => number = callback => requestAnimationFrame(callback),
  cancelFrame: (handle: number) => void = handle => cancelAnimationFrame(handle),
): RafScheduler {
  const pendingBySession = new Map<string, number>();

  return {
    schedule(sessionId: string) {
      if (!isActiveSession(sessionId)) {
        return;
      }
      if (pendingBySession.has(sessionId)) {
        return;
      }
      const handle = scheduleFrame(() => {
        if (!pendingBySession.has(sessionId)) {
          return;
        }
        pendingBySession.delete(sessionId);
        onNotify();
      });
      pendingBySession.set(sessionId, handle);
    },
    cancelAll() {
      pendingBySession.forEach(handle => cancelFrame(handle));
      pendingBySession.clear();
    },
  };
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

export const STALE_THRESHOLD_MS = 30_000;

export const MAX_REALTIME_MESSAGES = 500;

// Message kinds invisible in the UI (they convert to null) — skip merged
// recomputation and React re-render when appending them; the next visible
// message triggers the recompute anyway.
export const INVISIBLE_REALTIME_KINDS = new Set([
  "status",
  "session_created",
  "permission_cancelled",
  "compact_boundary",
]);
