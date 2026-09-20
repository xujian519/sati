import { type MutableRefObject, useEffect, useRef } from "react";
import { logError } from "../../../utils/logging";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { ClaudeWorkStatus, SatiWorkStatus } from "../types/types";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import type { Project, ProjectSession, SessionRequestParams } from "../../../types/app";
import type { SessionStore } from "../../../stores/useSessionStore";
import type { ChatSessionFetchParams } from "./use-chat-pagination-scroll";

/**
 * 会话生命周期 —— 从 `useChatSessionState` 拆出的独立 hook（issue #467）。
 *
 * 两条 effect 一起搬：
 *
 * 1. **会话加载**（store-based）：无会话时整块复位（但让位给「待建会话」交班窗口）、
 *    同 key 且新鲜/仍有实时内容时跳过重取、切会话时复位分页与流式态、发
 *    `check-session-status`、全量取数（`limit: null`，见 effect 内的注释）。
 * 2. **外部消息刷新**：`externalMessageUpdate` 递增时 `refreshFromServer`，
 *    流式期间跳过；开启跟随且贴底时经沉降延时落底。
 *
 * 持有 `lastLoadedSessionKeyRef`（「上次为哪个会话加载过」的唯一真源，也是
 * `didLoadedSessionChange` 的判据），调用方不再需要它。
 *
 * ⚠️ 调用点在主 hook 里**必须在分页 hook 之后、搜索定位 effect 之前/左右相邻处**：
 * 这两条 effect 在拆分前的展开顺序就是紧跟分页 hook 的 5 条 effect，且分页复位
 * （`resetPagination`）与搜索定位的次序都取决于此。
 */

export interface UseChatSessionLifecycleArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  pendingViewSessionRef: MutableRefObject<{ sessionId: string | null; startedAt: number } | null>;
  sessionRequestParams: SessionRequestParams;
  sessionIsReadOnly: boolean;
  sessionStore: SessionStore;
  buildFetchParams: (project: Project) => ChatSessionFetchParams;
  ws: WebSocket | null;
  sendMessage: (message: WsMessage) => void;
  messagesOffsetRef: MutableRefObject<number>;
  resetStreamingState: () => void;
  resetPagination: () => void;
  setIsLoadingSessionMessages: (value: boolean) => void;
  setHasMoreMessages: (value: boolean) => void;
  setTotalMessages: (value: number) => void;
  setViewHiddenCount: (value: number) => void;
  setTokenBudget: (value: Record<string, unknown> | null) => void;
  setClaudeStatus: (value: ClaudeWorkStatus | null) => void;
  setSatiStatus: (value: SatiWorkStatus | null) => void;
  setCanAbortSession: (value: boolean) => void;
  setIsAborting: (value: boolean) => void;
  setIsLoading: (value: boolean) => void;
  setSessionLoadError: (value: string | null) => void;
  setCurrentSessionId: (value: string | null) => void;
  setPendingUserMessage: (value: null) => void;
  /** 外部刷新触发计数（WebSocket 重连 / 后台刷新）。 */
  externalMessageUpdate?: number;
  autoScrollToBottom?: boolean;
  isLoading: boolean;
  isNearBottom: () => boolean;
  scrollToBottom: () => void;
}

/**
 * Whether the session-loading effect is entering a different session than
 * the one it last loaded for. Lives next to `lastLoadedSessionKeyRef` because
 * it must NOT consult `currentSessionId` — that piece of React state is
 * eagerly mirrored to `selectedSession.id` during render to keep the OLD
 * session's messages from bleeding into a freshly-cleared view, which means
 * by the time effects run it is already equal to `selectedSession.id`.
 * Using it for change-detection would always evaluate to false on a real
 * session-to-session switch, leaving stale per-session state (e.g. a
 * `tokenBudget` from the previous session) into the new view.
 */
export function didLoadedSessionChange(lastLoadedSessionKey: string | null, incomingSessionKey: string): boolean {
  return lastLoadedSessionKey !== null && lastLoadedSessionKey !== incomingSessionKey;
}

export function useChatSessionLifecycle({
  selectedProject,
  selectedSession,
  currentSessionId,
  pendingViewSessionRef,
  sessionRequestParams,
  sessionIsReadOnly,
  sessionStore,
  buildFetchParams,
  ws,
  sendMessage,
  messagesOffsetRef,
  resetStreamingState,
  resetPagination,
  setIsLoadingSessionMessages,
  setHasMoreMessages,
  setTotalMessages,
  setViewHiddenCount,
  setTokenBudget,
  setClaudeStatus,
  setSatiStatus,
  setCanAbortSession,
  setIsAborting,
  setIsLoading,
  setSessionLoadError,
  setCurrentSessionId,
  setPendingUserMessage,
  externalMessageUpdate,
  autoScrollToBottom,
  isLoading,
  isNearBottom,
  scrollToBottom,
}: UseChatSessionLifecycleArgs) {
  const lastLoadedSessionKeyRef = useRef<string | null>(null);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // Guard: skip the full reset while a new-session handoff is in
      // flight. Two distinct transient windows must be protected:
      //
      // 1. session_created already arrived → currentSessionId is set and
      //    matches the pendingViewSession, but selectedSession hasn't
      //    resolved yet (projects list refresh still in progress).
      //
      // 2. The user just submitted from the welcome surface and we're
      //    still waiting for session_created. pendingViewSessionRef has
      //    been allocated (with sessionId: null) but the backend hasn't
      //    responded yet. A projects_updated WS message can change
      //    selectedProject's reference and re-fire this effect — the
      //    reset would wipe pendingUserMessage and flash back to welcome.
      const isPendingSessionHandoff =
        Boolean(currentSessionId) && pendingViewSessionRef.current?.sessionId === currentSessionId;
      const isAwaitingSessionCreation =
        pendingViewSessionRef.current !== null && !pendingViewSessionRef.current.sessionId;
      if (!selectedSession && (isPendingSessionHandoff || isAwaitingSessionCreation)) {
        return;
      }
      resetStreamingState();
      pendingViewSessionRef.current = null;
      setPendingUserMessage(null);
      setClaudeStatus(null);
      setSatiStatus(null);
      setCanAbortSession(false);
      setIsAborting(false);
      setIsLoading(false);
      setSessionLoadError(null);
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const provider = "sati";
    const sessionKey = JSON.stringify([
      selectedSession.id,
      selectedProject.name,
      provider,
      sessionRequestParams.sessionKind ?? "",
      sessionRequestParams.parentSessionId ?? "",
      sessionRequestParams.relativeTranscriptPath ?? "",
      sessionIsReadOnly ? "readonly" : "readwrite",
    ]);

    // Skip if already loaded and fresh, or if stale but has live realtime
    // content (re-fetching while streaming would prune in-flight messages).
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSession.id)) {
      const hasRealtimeContent = (sessionStore.getSessionSlot?.(selectedSession.id)?.realtimeMessages?.length ?? 0) > 0;
      if (!sessionStore.isStale(selectedSession.id) || hasRealtimeContent) {
        return;
      }
    }

    // See `didLoadedSessionChange` for why we don't compare `currentSessionId`
    // against `selectedSession.id` here (the render-phase mirror nullifies
    // that check on real session-to-session switches).
    const sessionChanged = didLoadedSessionChange(lastLoadedSessionKeyRef.current, sessionKey);
    if (sessionChanged) {
      resetStreamingState();
      pendingViewSessionRef.current = null;
      setClaudeStatus(null);
      setSatiStatus(null);
      setSessionLoadError(null);
      setCanAbortSession(false);
      setIsAborting(false);
    }

    // Reset pagination/scroll state
    resetPagination();

    setViewHiddenCount(0);

    if (sessionChanged) {
      setTokenBudget(null);
      setIsLoading(false);
    }

    setCurrentSessionId(selectedSession.id);
    setSessionLoadError(null);

    // Check session status
    if (ws && !sessionIsReadOnly) {
      sendMessage({
        type: "check-session-status",
        sessionId: selectedSession.id,
        provider,
        includeActiveTurnMessages: true,
      });
    }

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    // Intentionally fetch the WHOLE transcript on session entry: Sati's
    // `readSessionMessages` slices in jsonl-forward order (`allMessages.slice(
    // offset, offset+limit)`), but the ui-side `fetchMore` path that handles
    // scroll-to-top assumes "more older messages" semantics and prepends the
    // returned batch to serverMessages. The two are incompatible, so paging
    // here produces a reordered transcript (the second-page batch — actually
    // the *newer* tail messages — gets prepended in front of the older ones
    // already on screen). Sessions are typically well under a few hundred
    // messages, so fetching everything is fine.
    sessionStore
      .fetchFromServer(selectedSession.id, {
        ...buildFetchParams(selectedProject),
        limit: null,
        offset: 0,
      })
      .then(slot => {
        if (slot) {
          setHasMoreMessages(slot.hasMore);
          setTotalMessages(slot.total);
          if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
          setSessionLoadError(
            slot.status === "error" ? slot.lastError || "Unable to load conversation messages." : null,
          );
        }
        setIsLoadingSessionMessages(false);
      })
      .catch(error => {
        setSessionLoadError(error instanceof Error ? error.message : "Unable to load conversation messages.");
        setIsLoadingSessionMessages(false);
      });
  }, [
    buildFetchParams,
    currentSessionId,
    pendingViewSessionRef,
    resetStreamingState,
    selectedProject,
    selectedSession,
    sendMessage,
    ws,
    sessionIsReadOnly,
    sessionRequestParams,
    sessionStore,
    messagesOffsetRef,
    resetPagination,
    setIsLoadingSessionMessages,
    setHasMoreMessages,
    setTotalMessages,
    setViewHiddenCount,
    setPendingUserMessage,
    setClaudeStatus,
    setSatiStatus,
    setCanAbortSession,
    setIsAborting,
    setIsLoading,
    setSessionLoadError,
    setCurrentSessionId,
    setTokenBudget,
    lastLoadedSessionKeyRef,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isLoading) {
          await sessionStore.refreshFromServer(selectedSession.id, buildFetchParams(selectedProject));

          if (Boolean(autoScrollToBottom) && isNearBottom()) {
            setTimeout(() => scrollToBottom(), UI_TIMEOUTS.CHAT_RELOAD_SCROLL_SETTLE_MS);
          }
        }
      } catch (error) {
        logError("Error reloading messages from external update:", error);
      }
    };

    reloadExternalMessages();
  }, [
    autoScrollToBottom,
    buildFetchParams,
    externalMessageUpdate,
    isNearBottom,
    scrollToBottom,
    selectedProject,
    selectedSession,
    sessionStore,
    isLoading,
  ]);
}
