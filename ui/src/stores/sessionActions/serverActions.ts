import type { SessionProvider } from "../../types/app";
import { authenticatedFetch } from "../../utils/api";
import { logError } from "../../utils/logging";
import {
  appendSessionQueryParams,
  buildMessagesUrl,
  ensureMessagesResponseOk,
  recomputeMergedIfNeeded,
  shouldKeepRealtimeAfterServerRefresh,
  STALE_THRESHOLD_MS,
  type NormalizedMessage,
} from "../sessionStoreCore";
import type { SessionActionContext } from "./context";

export function createServerActions(ctx: SessionActionContext) {
  const { getSlot, notify, storeRef } = ctx;

  /**
   * Fetch messages from the unified endpoint and populate serverMessages.
   */
  const fetchFromServer = async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      sessionKind?: string;
      parentSessionId?: string;
      relativeTranscriptPath?: string;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    slot.status = "loading";
    notify(sessionId);

    const fetchStartedAt = Date.now();

    try {
      const params = new URLSearchParams();
      appendSessionQueryParams(params, opts);
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append("limit", String(opts.limit));
        params.append("offset", String(opts.offset ?? 0));
      }

      const url = buildMessagesUrl(sessionId, params);
      const response = await authenticatedFetch(url, { suppressServerErrorToast: true });

      await ensureMessagesResponseOk(response, "load");

      const data = await response.json();
      const messages: NormalizedMessage[] = data.messages || [];

      slot.serverMessages = messages;
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = "idle";
      slot.lastError = null;

      // Prune realtime messages covered by server data.  Use the later of
      // fetchStartedAt and the latest server message timestamp as watermark
      // so that messages finalized DURING the fetch (race window) are also
      // pruned when the server response already includes them.
      if (slot.realtimeMessages.length > 0 && messages.length > 0) {
        const latestServerTs = messages.reduce((max, m) => Math.max(max, Date.parse(m.timestamp) || 0), 0);
        const watermark = Math.max(fetchStartedAt, latestServerTs);
        const serverIds = new Set(messages.map(m => m.id));
        const serverToolIds = new Set(messages.filter(m => m.kind === "tool_use" && m.toolId).map(m => m.toolId!));
        slot.realtimeMessages = slot.realtimeMessages.filter(m => {
          if (shouldKeepRealtimeAfterServerRefresh(m, messages)) return true;
          if (serverIds.has(m.id)) return false;
          if (m.kind === "tool_use" && m.toolId && serverToolIds.has(m.toolId)) return false;
          return (Date.parse(m.timestamp) || 0) > watermark;
        });
      }

      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(sessionId);
      return slot;
    } catch (error) {
      logError(`[SessionStore] fetch failed for ${sessionId}:`, error);
      slot.status = "error";
      slot.lastError = error instanceof Error ? error.message : "Unknown error";
      notify(sessionId);
      return slot;
    }
  };

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      sessionKind?: string;
      parentSessionId?: string;
      relativeTranscriptPath?: string;
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    appendSessionQueryParams(params, opts);
    const limit = opts.limit ?? 20;
    params.append("limit", String(limit));
    params.append("offset", String(slot.offset));

    const url = buildMessagesUrl(sessionId, params);

    try {
      const response = await authenticatedFetch(url, { suppressServerErrorToast: true });
      await ensureMessagesResponseOk(response, "load");
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // Prepend older messages (they're earlier in the conversation)
      slot.serverMessages = [...olderMessages, ...slot.serverMessages];
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      logError(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  };

  /**
   * Re-fetch serverMessages from the unified endpoint (e.g., on projects_updated).
   */
  const refreshFromServer = async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      sessionKind?: string;
      parentSessionId?: string;
      relativeTranscriptPath?: string;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    try {
      const params = new URLSearchParams();
      appendSessionQueryParams(params, opts);
      const url = buildMessagesUrl(sessionId, params);
      const response = await authenticatedFetch(url, { suppressServerErrorToast: true });

      await ensureMessagesResponseOk(response, "refresh");
      const data = await response.json();

      const incomingMessages = data.messages || [];
      // Don't overwrite existing server messages with empty response
      // (race condition: server hasn't committed yet after stop/complete).
      if (incomingMessages.length > 0 || slot.serverMessages.length === 0) {
        slot.serverMessages = incomingMessages;
      }
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // Server is authoritative, but a post-complete refresh can race the
      // transcript writer/read path and return a non-empty yet not-quite-final
      // snapshot. Keep finalized local stream text until the server returns
      // an equivalent assistant message; otherwise the UI can show "complete"
      // while the model's visible answer disappears.
      if (slot.realtimeMessages.length > 0 && incomingMessages.length > 0) {
        slot.realtimeMessages = slot.realtimeMessages.filter(message =>
          shouldKeepRealtimeAfterServerRefresh(message, incomingMessages),
        );
      }
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    } catch (error) {
      logError(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  };

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = (sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  };

  return { fetchFromServer, fetchMore, refreshFromServer, isStale };
}
