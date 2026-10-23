import { useEffect, useMemo, useRef } from "react";
import { useWebSocket } from "../../../contexts/WebSocketContext";
import { createChatRealtimeMessageHandler } from "./chatRealtimeHandlers";
import type { UseChatRealtimeHandlersArgs } from "./chatRealtimeTypes";
import { useSessionStatusRetryTimers } from "./useSessionStatusRetryTimers";

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatRealtimeHandlers({
  provider,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setIsAborting,
  setClaudeStatus,
  setSatiStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  setPendingApprovals,
  pendingViewSessionRef,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  selectedProject,
  onReplaceTemporarySession,
  onNavigateToSession,
  onWebSocketReconnect,
  onRewriteError,
  sessionStore,
  sendMessage,
}: UseChatRealtimeHandlersArgs) {
  const { subscribe } = useWebSocket();

  // Track which sessions have active thinking (just a boolean flag now)
  const thinkingBySessionRef = useRef<Map<string, boolean>>(new Map());
  // Dedup volatile active-turn replay chunks across reconnect/status polls.
  const activeTurnReplaySignatureRef = useRef<Map<string, string>>(new Map());

  const { clearSessionStatusRetry, scheduleSessionStatusRetry } = useSessionStatusRetryTimers({
    provider,
    sendMessage,
  });

  // The handler registry captures every render-scoped input, so rebuilding it
  // on the same dependencies preserves the previous useCallback identity
  // semantics for the subscribe effect.
  const handleMessage = useMemo(
    () =>
      createChatRealtimeMessageHandler({
        provider,
        selectedProject,
        selectedSession,
        currentSessionId,
        setCurrentSessionId,
        setIsLoading,
        setCanAbortSession,
        setIsAborting,
        setClaudeStatus,
        setSatiStatus,
        setTokenBudget,
        setPendingPermissionRequests,
        setPendingApprovals,
        pendingViewSessionRef,
        onSessionInactive,
        onSessionProcessing,
        onSessionNotProcessing,
        onReplaceTemporarySession,
        onNavigateToSession,
        onWebSocketReconnect,
        onRewriteError,
        sessionStore,
        thinkingBySessionRef,
        activeTurnReplaySignatureRef,
        clearSessionStatusRetry,
        scheduleSessionStatusRetry,
      }),
    [
      provider,
      clearSessionStatusRetry,
      scheduleSessionStatusRetry,
      selectedSession,
      currentSessionId,
      setCurrentSessionId,
      setIsLoading,
      setCanAbortSession,
      setIsAborting,
      setClaudeStatus,
      setSatiStatus,
      setTokenBudget,
      setPendingPermissionRequests,
      setPendingApprovals,
      pendingViewSessionRef,
      onSessionInactive,
      onSessionProcessing,
      onSessionNotProcessing,
      onReplaceTemporarySession,
      onNavigateToSession,
      onWebSocketReconnect,
      onRewriteError,
      selectedProject,
      sessionStore,
    ],
  );

  useEffect(() => {
    if (!subscribe) return;
    return subscribe(handleMessage);
  }, [subscribe, handleMessage]);
}
