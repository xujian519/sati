import { useCallback, useEffect, useRef } from "react";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { SessionProvider } from "../../../types/app";

type UseSessionStatusRetryTimersArgs = {
  provider: SessionProvider;
  sendMessage?: (message: Record<string, unknown>) => void;
};

export type SessionStatusRetryTimers = {
  clearSessionStatusRetry: (sessionId: string) => void;
  scheduleSessionStatusRetry: (sessionId: string) => void;
};

export function useSessionStatusRetryTimers({
  provider,
  sendMessage,
}: UseSessionStatusRetryTimersArgs): SessionStatusRetryTimers {
  // Pending session-status retries while gateway activity is unknown.
  const sessionStatusRetryTimersRef = useRef<Map<string, number>>(new Map());

  const clearSessionStatusRetry = useCallback((sessionId: string) => {
    const timer = sessionStatusRetryTimersRef.current.get(sessionId);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    sessionStatusRetryTimersRef.current.delete(sessionId);
  }, []);

  const scheduleSessionStatusRetry = useCallback(
    (sessionId: string) => {
      if (sessionStatusRetryTimersRef.current.has(sessionId)) return;
      const timer = window.setTimeout(() => {
        sessionStatusRetryTimersRef.current.delete(sessionId);
        sendMessage?.({ type: "check-session-status", sessionId, provider, includeActiveTurnMessages: true });
      }, UI_TIMEOUTS.SESSION_STATUS_UNKNOWN_RETRY_MS);
      sessionStatusRetryTimersRef.current.set(sessionId, timer);
    },
    [provider, sendMessage],
  );

  useEffect(
    () => () => {
      for (const timer of sessionStatusRetryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      sessionStatusRetryTimersRef.current.clear();
    },
    [],
  );

  return { clearSessionStatusRetry, scheduleSessionStatusRetry };
}
