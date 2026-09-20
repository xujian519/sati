import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { logError } from "../../../utils/logging";
import { authenticatedFetch } from "../../../utils/api";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import type { ChatMessage, ClaudeWorkStatus, SatiWorkStatus } from "../types/types";
import {
  getSessionRequestParams,
  isReadOnlySession,
  type Project,
  type ProjectSession,
  type SessionProvider,
} from "../../../types/app";
import type { SessionStore, NormalizedMessage } from "../../../stores/useSessionStore";
import { parseUserAttachmentNote } from "../utils/attachmentNotes";
import { createCachedDiffCalculator, type DiffCalculator } from "../utils/messageTransforms";
import { normalizedToChatMessages } from "./useChatMessages";
import { useChatPaginationScroll } from "./use-chat-pagination-scroll";
import { useChatScrollAnchor } from "./use-chat-scroll-anchor";
import { useChatSearchNavigation } from "./use-chat-search-navigation";

const EMPTY_NORMALIZED_MESSAGES: NormalizedMessage[] = [];

// 滚动定位数学（`isScrollNearBottom` / `resolveConversationScrollTop` /
// `BOTTOM_FOLLOW_THRESHOLD_PX`）随分页/滚动一族搬到 ./use-chat-pagination-scroll，
// 这里保留同一导出路径：既有测试与调用方按 `./useChatSessionState` 取用不受影响。
export {
  BOTTOM_FOLLOW_THRESHOLD_PX,
  isScrollNearBottom,
  resolveConversationScrollTop,
} from "./use-chat-pagination-scroll";

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: WsMessage) => void;
  autoScrollToBottom?: boolean;
  externalMessageUpdate?: number;
  processingSessions?: Set<string>;
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  sessionStore: SessionStore;
}

/**
 * Whether the session-loading effect is entering a different session than
 * the one it last loaded for. Lives next to `lastLoadedSessionKeyRef` because
 * it must NOT consult `currentSessionId` — that piece of React state is
 * eagerly mirrored to `selectedSession.id` during render to keep the OLD
 * session's messages from bleeding into a freshly-cleared view, which means
 * by the time effects run it is already equal to `selectedSession.id`.
 * Using it for change-detection would always evaluate to false on a real
 * `tokenBudget` from the previous session into the new view.
 */
export function didLoadedSessionChange(lastLoadedSessionKey: string | null, incomingSessionKey: string): boolean {
  return lastLoadedSessionKey !== null && lastLoadedSessionKey !== incomingSessionKey;
}

/**
 * Whether the optimistic "pending user message" bubble should render in the
 * currently active view. The pending bubble is hook-wide singleton state on
 * `ChatInterfaceV2`; without this gate, switching sessions while it's queued
 * would prepend the optimistic text onto the WRONG session's transcript —
 * surfaced as "the latest query I just typed appears at the top of an
 * unrelated session I just opened".
 *
 * It belongs here iff:
 *   1. We are still on the welcome surface (no active session yet) — the
 *      pending bubble is the only thing the user can see.
 *   2. The active session id matches the session id `pendingViewSessionRef`
 *      was bound to at submit time (stamped by `session_created`).
 */
export function shouldRenderPendingBubble(
  activeSessionId: string | null,
  pendingTargetSessionId: string | null,
): boolean {
  if (!activeSessionId) return true;
  return pendingTargetSessionId !== null && pendingTargetSessionId === activeSessionId;
}

export function getStreamContentKey(messages: ChatMessage[]): string {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    return "empty";
  }

  const contentLength = typeof lastMessage.content === "string" ? lastMessage.content.length : 0;
  const toolContent = lastMessage.toolResult?.content;
  const toolContentLength = typeof toolContent === "string" ? toolContent.length : 0;
  return [
    lastMessage.id || "",
    lastMessage.type || "",
    lastMessage.isStreaming ? "streaming" : "",
    contentLength,
    toolContentLength,
    messages.length,
  ].join(":");
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: SessionProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts =
    msg.timestamp instanceof Date
      ? msg.timestamp.toISOString()
      : typeof msg.timestamp === "number"
        ? new Date(msg.timestamp).toISOString()
        : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: "tool_use",
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: "thinking", content: msg.content || "" } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: "interactive_prompt", content: msg.content || "" } as NormalizedMessage;
  }
  if (msg.isTaskNotification) {
    return {
      ...base,
      kind: "task_notification",
      status: msg.taskStatus || "completed",
      summary: msg.content || "",
    } as NormalizedMessage;
  }
  if (msg.type === "error") {
    return {
      ...base,
      kind: "error",
      content: msg.content || "",
      ...(typeof msg.userHint === "string" ? { userHint: msg.userHint } : {}),
    } as NormalizedMessage;
  }
  // Carry user-attached image data URLs through the normalize round-trip
  // so the optimistic message render and any re-derivation from the
  // session store both show the thumbnails. NormalizedMessage.images is
  // `string[]` of data URLs; we only attach it on user-side text frames.
  const images =
    msg.type === "user" && Array.isArray(msg.images)
      ? msg.images.filter(img => img && typeof img.data === "string").map(img => img.data)
      : undefined;
  const attachments =
    msg.type === "user" && Array.isArray(msg.attachments)
      ? msg.attachments.filter(attachment => attachment && typeof attachment.name === "string")
      : undefined;
  return {
    ...base,
    kind: "text",
    role: msg.type === "user" ? "user" : "assistant",
    content: msg.content || "",
    ...(images && images.length > 0 ? { images } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  } as NormalizedMessage;
}

function normalizeUserMessageText(value: unknown): string {
  const parsed = parseUserAttachmentNote(value);
  return parsed.content.replace(/\s+/g, " ").trim();
}

function getUserAttachmentNames(message: ChatMessage): string[] {
  const explicitNames = Array.isArray(message.attachments)
    ? message.attachments.map(attachment => attachment.name || "").filter(Boolean)
    : [];
  const parsedNames = parseUserAttachmentNote(message.content)
    .attachments.map(attachment => attachment.name || "")
    .filter(Boolean);
  return [...explicitNames, ...parsedNames].sort();
}

export function hasEquivalentUserMessage(messages: ChatMessage[], pendingUserMessage: ChatMessage): boolean {
  const pendingText = normalizeUserMessageText(pendingUserMessage.content);
  const pendingImageCount = Array.isArray(pendingUserMessage.images) ? pendingUserMessage.images.length : 0;
  const pendingAttachmentNames = getUserAttachmentNames(pendingUserMessage);
  // 同一文本连发两次时，文本 + 图片数 + 附件名可能完全一致（例如重复问同一句），
  // 只按内容比较会把第二次的乐观气泡吞掉。两侧都带 turnId/runId 时以它为身份
  // （同一 turn 才是同一条消息），否则退回内容比较。
  const pendingTurnId = pendingUserMessage.turnId || pendingUserMessage.runId;

  return messages.some(message => {
    if (message.type !== "user") return false;
    const messageTurnId = message.turnId || message.runId;
    if (pendingTurnId || messageTurnId) {
      return Boolean(pendingTurnId && messageTurnId && pendingTurnId === messageTurnId);
    }
    if (normalizeUserMessageText(message.content) !== pendingText) return false;

    const imageCount = Array.isArray(message.images) ? message.images.length : 0;
    if (imageCount !== pendingImageCount) return false;

    const attachmentNames = getUserAttachmentNames(message);
    return attachmentNames.join("\n") === pendingAttachmentNames.join("\n");
  });
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  autoScrollToBottom,
  externalMessageUpdate,
  processingSessions,
  resetStreamingState,
  pendingViewSessionRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeWorkStatus | null>(null);
  const [satiStatus, setSatiStatus] = useState<SatiWorkStatus | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const searchScrollActiveRef = useRef(false);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */

  // Bug fix (was: `selectedSession?.id || currentSessionId || null`): when the
  // user clicks "+ session" the parent flips `selectedSession` to null, but
  // `currentSessionId` still holds the previous session's id for one render
  // tick — so storeMessages would briefly read the OLD session's messages
  // and bleed them into the freshly-cleared chat view.
  //
  // Strategy:
  //   1. Mirror `selectedSession.id` into `currentSessionId` during render
  //      whenever the selection changes — drops any stale carryover.
  //   2. Expose an `effectiveCurrentSessionId` ref so the *current* render
  //      uses the cleared value, not the lagging React state.
  //   3. While the selection is stable but `currentSessionId` advances
  //      (e.g. backend emits `session_created` for a from-welcome submit
  //      before the parent navigates), keep mirroring forward so the new
  //      id is visible immediately.
  const selSid = selectedSession?.id ?? null;
  const lastSeenSelSidRef = useRef<string | null>(selSid);
  const effectiveCurrentRef = useRef<string | null>(selSid);
  if (lastSeenSelSidRef.current !== selSid) {
    lastSeenSelSidRef.current = selSid;
    effectiveCurrentRef.current = selSid;
    if (currentSessionId !== selSid) {
      setCurrentSessionId(selSid);
    }
  } else if (currentSessionId !== effectiveCurrentRef.current) {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const isPendingSessionHandoff = Boolean(currentSessionId) && pendingSessionId === currentSessionId;
    if (selSid) {
      effectiveCurrentRef.current = selSid;
      if (currentSessionId !== selSid) {
        setCurrentSessionId(selSid);
      }
    } else if (isPendingSessionHandoff) {
      effectiveCurrentRef.current = currentSessionId;
    } else {
      effectiveCurrentRef.current = null;
      if (currentSessionId !== null) {
        setCurrentSessionId(null);
      }
    }
  }
  const pendingSessionIdForRender = pendingViewSessionRef.current?.sessionId ?? null;
  // No selectedSession means we are intentionally on a fresh chat surface unless
  // the backend is still handing us the real id for the first message.
  const hasStaleUnselectedCurrentSession =
    Boolean(currentSessionId) && !selSid && pendingSessionIdForRender !== currentSessionId;
  if (hasStaleUnselectedCurrentSession) {
    effectiveCurrentRef.current = null;
    setCurrentSessionId(null);
  }

  const activeSessionId = selSid ?? effectiveCurrentRef.current;
  const activeScrollKey = selectedProject && activeSessionId ? `${selectedProject.name}:${activeSessionId}` : null;
  const sessionIsReadOnly = isReadOnlySession(selectedSession);
  const sessionRequestParams = useMemo(() => getSessionRequestParams(selectedSession), [selectedSession]);

  // store 拉取参数的公共前缀（5 处调用点逐字一致）——单一事实源防漂移。
  const buildFetchParams = useCallback(
    (project: Project) => ({
      provider: "sati" as SessionProvider,
      projectName: project.name,
      projectPath: project.fullPath || project.path || "",
      ...sessionRequestParams,
    }),
    [sessionRequestParams],
  );
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  // When a real session ID arrives and we have a pending user message, flush
  // it to the store. The flush MUST be gated on `pendingViewSessionRef`: that
  // ref is what the composer + the session_created handler use to record the
  // sessionId that this pending message was actually queued for. Without that
  // gate, a user who types in welcome mode and then clicks an existing
  // session in the sidebar before session_created arrives would have their
  // pending text leaked into the unrelated session's realtime slot — and
  // because realtime slots are not cleared on session switch, that ghost
  // message would re-appear on every subsequent reopen.
  const prevActiveSessionRef = useRef<string | null>(null);
  if (activeSessionId && activeSessionId !== prevActiveSessionRef.current && pendingUserMessage) {
    const expectedSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    if (expectedSessionId && activeSessionId === expectedSessionId) {
      const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, "sati");
      if (normalized) {
        sessionStore.appendRealtime(activeSessionId, normalized);
      }
    }
    setPendingUserMessage(null);
  }
  prevActiveSessionRef.current = activeSessionId;

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : EMPTY_NORMALIZED_MESSAGES;
  // 空分支用模块级常量（与 storeMessages 同款模式）：保持引用稳定，使下方
  // activityMessages useMemo 依赖不随渲染变化（exhaustive-deps），同时保留
  // 「slot.activityMessages 引用替换 → 重算」的引用级失效语义。
  const activityStoreMessages = activeSessionId
    ? (sessionStore.getActivityMessages?.(activeSessionId) ?? EMPTY_NORMALIZED_MESSAGES)
    : EMPTY_NORMALIZED_MESSAGES;
  const subagentLinks = activeSessionId ? sessionStore.getSessionSlot?.(activeSessionId)?.subagentLinks : undefined;

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  // `pendingViewSessionRef.current.sessionId` is the session the optimistic
  // bubble was actually queued for. session_created stamps it. We read it
  // here AND list it as a memo dep (via `pendingTargetSessionId`) so the
  // memo recomputes when session_created upgrades the ref from null → real id.
  const pendingTargetSessionId = pendingViewSessionRef.current?.sessionId ?? null;

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages, subagentLinks);
    // The optimistic user bubble must ONLY render in the session it was
    // submitted into. Two valid surfaces:
    //   1. The welcome surface itself (activeSessionId=null), while we are
    //      still waiting for `session_created` to tell us the real id.
    //   2. The exact session id that `pendingViewSessionRef` was bound to
    //      at submit time.
    // Without this gate, a sidebar click after a welcome submit (or any
    // session switch while the bubble is queued) would prepend the
    // optimistic text onto the WRONG session's transcript — surfaced as
    // "the latest query I just typed appears at the top of an unrelated
    // session I just opened". The handoff block above eventually pushes
    // the bubble into the right store + clears it, but React's discard-
    // and-rerender on render-phase setState isn't a guarantee under
    // concurrent rendering / batched parent updates, so we also defend
    // here at the read site.
    const pendingBelongsHere = shouldRenderPendingBubble(activeSessionId, pendingTargetSessionId);
    if (pendingUserMessage && pendingBelongsHere && !hasEquivalentUserMessage(all, pendingUserMessage)) {
      return [pendingUserMessage, ...all];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage, activeSessionId, pendingTargetSessionId, subagentLinks]);

  // 流式 tick 高频 render：activityStoreMessages 引用在 store 未更新时稳定
  // （slot.activityMessages 只在 upsertActivity/setActivities 时替换），
  // useMemo 命中跳过每 tick 的 normalizedToChatMessages 全量转换（P3-1）。
  const activityMessages = useMemo(() => normalizedToChatMessages(activityStoreMessages), [activityStoreMessages]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback(
    (msg: ChatMessage, targetSessionId?: string | null) => {
      const sessionId = targetSessionId !== undefined ? targetSessionId : activeSessionId;
      if (!sessionId) {
        // No session yet — show as pending until the backend creates one
        setPendingUserMessage(msg);
        return;
      }
      const normalized = chatMessageToNormalized(msg, sessionId, "sati");
      if (normalized) {
        sessionStore.appendRealtime(sessionId, normalized);
      }
    },
    [activeSessionId, sessionStore],
  );

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  /* ---------------------------------------------------------------- */
  /*  分页窗口 + 滚动定位（#159 N02 拆到 useChatPaginationScroll）        */
  /* ---------------------------------------------------------------- */

  // 调用点位置就是语义：本 hook 的 effect（加载后保持位置 / 会话切换复位 /
  // 会话内位置恢复 / 首屏落底）在拆分前就排在下面的「会话加载 effect」与更下方的
  // 「搜索定位 effect」之前——`pendingInitialScrollRef` 与 `searchScrollActiveRef`
  // 的读写次序决定首屏是否落到底、搜索跳转时是否被抢滚动。不要把它挪到它们之后。
  const {
    hasMoreMessages,
    setHasMoreMessages,
    totalMessages,
    setTotalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    visibleMessageCount,
    setVisibleMessageCount,
    allMessagesLoaded,
    setAllMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    setShowLoadAllOverlay,
    messagesOffsetRef,
    allMessagesLoadedRef,
    pendingScrollRestoreRef,
    scrollPositionRef,
    isLoadingMoreRef,
    scrollContainerRef,
    scrollToBottom,
    scheduleScrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    loadAllMessages,
    loadEarlierMessages,
    visibleMessages,
    resetPagination,
  } = useChatPaginationScroll({
    chatMessages,
    activeScrollKey,
    isLoadingSessionMessages,
    selectedSession,
    selectedProject,
    currentSessionId,
    buildFetchParams,
    sessionStore,
    searchScrollActiveRef,
  });

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
    setHasMoreMessages,
    setTotalMessages,
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

  // 搜索定位（读取搜索目标 / 清交班标记 / 跳转与高亮）外置到 ./use-chat-search-navigation
  // （issue #467）。调用点即语义：这一段 effect 必须留在会话加载 effect 之后、滚动锚定之前
  // （`searchScrollActiveRef` 的置位次序决定首屏落底与锚定会不会抢搜索的滚动）。
  useChatSearchNavigation({
    selectedSession,
    selectedProject,
    sessionStore,
    buildFetchParams,
    chatMessages,
    isLoadingSessionMessages,
    allMessagesLoadedRef,
    messagesOffsetRef,
    scrollContainerRef,
    setAllMessagesLoaded,
    setHasMoreMessages,
    setTotalMessages,
    setVisibleMessageCount,
    searchScrollActiveRef,
    pendingViewSessionRef,
  });

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith("new-session-")) {
      setTokenBudget(null);
      return;
    }
    if (sessionIsReadOnly) {
      setTokenBudget(null);
      return;
    }

    const fetchInitialTokenUsage = async () => {
      try {
        const url = `/api/projects/${selectedProject.name}/sessions/${encodeURIComponent(selectedSession.id)}/token-usage?provider=sati`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          setTokenBudget(await response.json());
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        logError("Failed to fetch initial token usage:", error);
      }
    };
    fetchInitialTokenUsage();
  }, [sessionIsReadOnly, selectedProject, selectedSession?.id]);

  const streamContentKey = useMemo(() => getStreamContentKey(visibleMessages), [visibleMessages]);

  // 滚动锚定（跟随底部 / 增长时保住阅读位置 / 绑定 scroll 监听）。
  // 同样地，调用点即语义：这三条 effect 必须排在「会话加载」与「搜索定位」之后，
  // 它们会把 searchScrollActiveRef 置位、把 scrollTop 挪走，锚定快照取决于此。
  useChatScrollAnchor({
    autoScrollToBottom,
    chatMessages,
    streamContentKey,
    isUserScrolledUp,
    scrollContainerRef,
    scrollPositionRef,
    isLoadingMoreRef,
    pendingScrollRestoreRef,
    searchScrollActiveRef,
    scheduleScrollToBottom,
    handleScroll,
  });

  useEffect(() => {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeViewSessionId =
      selectedSession?.id || (pendingSessionId === currentSessionId ? currentSessionId : null);
    if (sessionIsReadOnly) return;
    if (!activeViewSessionId || !processingSessions) return;
    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing && !isLoading) {
      setIsLoading(true);
      setCanAbortSession(true);
    }
  }, [currentSessionId, isLoading, pendingViewSessionRef, processingSessions, selectedSession?.id, sessionIsReadOnly]);

  useEffect(() => {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeViewSessionId =
      selectedSession?.id || (pendingSessionId === currentSessionId ? currentSessionId : null);
    if (sessionIsReadOnly) return;
    if (!activeViewSessionId || !processingSessions) return;
    if (!processingSessions.has(activeViewSessionId)) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const requestStatus = () => {
      sendMessage({
        type: "check-session-status",
        sessionId: activeViewSessionId,
        provider: "sati",
        includeActiveTurnMessages: false,
      });
    };

    requestStatus();
    // 兜底存活探测：turn 开始/结束已有 stream_end/complete 事件驱动，
    // 5s 间隔足以维持中断按钮等状态的实时性，避免 1.2s 高频 session-status
    // 帧触发消费方整树 re-render（长任务数十分钟累计请求量减半）。
    const timer = setInterval(requestStatus, UI_TIMEOUTS.SESSION_STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [
    currentSessionId,
    pendingViewSessionRef,
    processingSessions,
    selectedSession?.id,
    sendMessage,
    sessionIsReadOnly,
    ws,
  ]);

  // "Load all" overlay：没有更多消息时收起遮罩。
  // 原先这里还有一条「上一轮在加载、这一轮加载结束、且还有更多」的分支，靠 isLoadingMoreMessages
  // 的状态迁移触发；但那个状态是 `useState(false)` 且**没有 setter**（恒 false），该分支从未执行过，
  // 已随死状态一并删除（#159 N02）。遮罩的置位仍由 loadAllMessages() 与下方的完成态 effect 负责。
  useEffect(() => {
    if (!hasMoreMessages) setShowLoadAllOverlay(false);
  }, [hasMoreMessages, setShowLoadAllOverlay]);

  return {
    chatMessages,
    activityMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadError,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting,
    setIsAborting,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    satiStatus,
    setSatiStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
  };
}
