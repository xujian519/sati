/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useMemo, useRef, useState } from "react";
import { createActivityActions } from "./sessionActions/activityActions";
import { createServerActions } from "./sessionActions/serverActions";
import { createStreamActions } from "./sessionActions/streamActions";
import { createSubagentActions } from "./sessionActions/subagentActions";
import { createSessionActionContext, type SessionActionDeps } from "./sessionActions/context";
import type { NormalizedMessage, RafScheduler, SessionSlot, SessionStatus } from "./sessionStoreCore";

export type {
  CompactProgress,
  MessageKind,
  NormalizedMessage,
  SessionSlot,
  SessionStatus,
} from "./sessionStoreCore";
export {
  computeMerged,
  createRafNotifyScheduler,
  getFinalizedSubagentThinkingId,
  patchMergedStreamingMessage,
  upsertRealtimeMessages,
} from "./sessionStoreCore";

// ─── Actions (module-level closures over one shared per-session store) ───────
//
// Every action below is a plain function, not a React hook. `useSessionStore`
// mints the four handles exactly once and assembles every action through this
// single factory, so a hook instance owns exactly ONE `Map<string, SessionSlot>`
// and no action can drift onto a private copy. Splitting these into sub-hooks
// would silently hand each one its own Map — 28 methods would keep "working"
// while reading and writing four mutually invisible stores.

function createSessionActions(deps: SessionActionDeps) {
  const ctx = createSessionActionContext(deps);
  const server = createServerActions(ctx);
  const stream = createStreamActions(ctx);
  const activity = createActivityActions(ctx);
  const subagent = createSubagentActions(ctx);
  const { getSlot, notify, storeRef } = ctx;

  /**
   * Update session status.
   */
  const setStatus = (sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  };

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = (sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  };

  const getActivityMessages = (sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.activityMessages ?? [];
  };

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = (sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  };

  // Key order is the public surface contract (28 actions) — keep it stable.
  return {
    getSlot: ctx.getSlot,
    has: ctx.has,
    fetchFromServer: server.fetchFromServer,
    fetchMore: server.fetchMore,
    appendRealtime: stream.appendRealtime,
    upsertActivity: activity.upsertActivity,
    setActivities: activity.setActivities,
    appendRealtimeBatch: stream.appendRealtimeBatch,
    refreshFromServer: server.refreshFromServer,
    setActiveSession: ctx.setActiveSession,
    setStatus,
    isStale: server.isStale,
    updateStreaming: stream.updateStreaming,
    finalizeStreaming: stream.finalizeStreaming,
    updateStreamingThinking: stream.updateStreamingThinking,
    finalizeStreamingThinking: stream.finalizeStreamingThinking,
    clearRealtime: stream.clearRealtime,
    clearAssistantRealtime: stream.clearAssistantRealtime,
    getMessages,
    getActivityMessages,
    getSubagentDetailMessages: subagent.getSubagentDetailMessages,
    getSessionSlot,
    recordSubagentLink: subagent.recordSubagentLink,
    appendSubagentDetailMessage: subagent.appendSubagentDetailMessage,
    updateSubagentDetailStreaming: subagent.updateSubagentDetailStreaming,
    finalizeSubagentDetailStreaming: subagent.finalizeSubagentDetailStreaming,
    updateSubagentDetailThinking: subagent.updateSubagentDetailThinking,
    finalizeSubagentDetailThinking: subagent.finalizeSubagentDetailThinking,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notifySchedulerRef = useRef<RafScheduler | null>(null);

  // Single assembly point (not a hook): the refs above are the only store
  // handles in the app, and every action closes over them.
  return useMemo(
    () =>
      createSessionActions({
        storeRef,
        activeSessionIdRef,
        notifySchedulerRef,
        setTick,
      }),
    [setTick],
  );
}

export type SessionStore = ReturnType<typeof useSessionStore>;
