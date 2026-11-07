import { useCallback, useEffect, useState } from "react";

const UNREAD_IGNORED_MESSAGE_TYPES = new Set([
  "websocket-reconnected",
  "pending-permissions-response",
  "session-status",
]);

const UNREAD_IGNORED_MESSAGE_KINDS = new Set(["session_created", "status", "stream_end"]);

const getSessionIdFromMessage = (message: unknown): string | null => {
  if (!message || typeof message !== "object") return null;
  const candidate = message as {
    sessionId?: unknown;
    session_id?: unknown;
    newSessionId?: unknown;
    actualSessionId?: unknown;
  };
  const value = candidate.sessionId ?? candidate.session_id ?? candidate.actualSessionId ?? candidate.newSessionId;
  return typeof value === "string" && value.trim() ? value : null;
};

const isUnreadWorthyMessage = (message: unknown): boolean => {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { kind?: unknown; type?: unknown };

  if (typeof candidate.kind === "string") {
    return !UNREAD_IGNORED_MESSAGE_KINDS.has(candidate.kind);
  }

  if (typeof candidate.type === "string") {
    return !UNREAD_IGNORED_MESSAGE_TYPES.has(candidate.type);
  }

  return false;
};

// Immutable add/remove updaters for the unread-session set: return the
// previous reference when nothing changes so React can skip the re-render.
const addUnreadSession =
  (sessionId: string) =>
  (previous: Set<string>): Set<string> => {
    if (previous.has(sessionId)) return previous;
    const next = new Set(previous);
    next.add(sessionId);
    return next;
  };

const removeUnreadSession =
  (sessionId: string) =>
  (previous: Set<string>): Set<string> => {
    if (!previous.has(sessionId)) return previous;
    const next = new Set(previous);
    next.delete(sessionId);
    return next;
  };

type UseUnreadSessionsArgs = {
  selectedSessionId?: string;
  subscribe: (handler: (message: unknown) => void) => () => void;
};

/** 侧栏未读圆点：选中会话即清除；WS 推送里非当前会话的可读事件标为未读。 */
export function useUnreadSessions({ selectedSessionId, subscribe }: UseUnreadSessionsArgs) {
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds(removeUnreadSession(selectedSessionId));
  }, [selectedSessionId]);

  useEffect(() => {
    return subscribe(message => {
      if (!isUnreadWorthyMessage(message)) return;

      const messageSessionId = getSessionIdFromMessage(message);
      if (!messageSessionId || messageSessionId === selectedSessionId) return;

      setUnreadSessionIds(addUnreadSession(messageSessionId));
    });
  }, [selectedSessionId, subscribe]);

  const markSessionRead = useCallback((sessionId: string) => {
    setUnreadSessionIds(removeUnreadSession(sessionId));
  }, []);

  return { unreadSessionIds, markSessionRead };
}
