import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { logError } from "../../../utils/logging";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { Project, ProjectSession, SessionProvider, SessionRequestParams } from "../../../types/app";
import type { SessionStore } from "../../../stores/useSessionStore";
import type { ChatMessage } from "../types/types";

/**
 * 消息窗口（分页）+ 滚动定位 —— 从 `useChatSessionState` 拆出的独立 hook（#159 TD-UI-CHAT-N02）。
 *
 * 这里只做**搬家**，语义与拆分前逐 token 等价；两族逻辑本来就是一件事：
 * `handleScroll` 既记录/恢复滚动位置，又用「贴顶」触发上一页，而
 * 「加载更多后保持位置」靠的就是 loadOlderMessages 记下阈值、layout effect 补偿高度。
 *
 * 单一真源：消息数组、分页游标、会话身份都由调用方（`useChatSessionState`）持有并通过
 * 参数传入；本 hook 只持有「窗口/滚动」自己的 state 与 ref，不复制外部数据。
 *
 * ⚠️ 调用点在主 hook 里**不是随意的**：本 hook 的 effect 必须留在
 * 「会话加载 effect / 搜索定位 effect」之前（`pendingInitialScrollRef` 与
 * `searchScrollActiveRef` 的读写次序决定首屏是否落到底），详见主 hook 的调用点注释。
 */

export const MESSAGES_PER_PAGE = 20;
export const INITIAL_VISIBLE_MESSAGES = 100;

export const BOTTOM_FOLLOW_THRESHOLD_PX = 96;

export function isScrollNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx = BOTTOM_FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
}

type ConversationScrollPosition = {
  top: number;
  distanceFromBottom: number;
};

const CONVERSATION_SCROLL_BOTTOM_THRESHOLD = 40;

export function resolveConversationScrollTop(
  position: ConversationScrollPosition,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (position.distanceFromBottom <= CONVERSATION_SCROLL_BOTTOM_THRESHOLD) {
    return maximumScrollTop;
  }
  return Math.min(Math.max(0, position.top), maximumScrollTop);
}

/** 加载更多前量取的容器指标，commit 后按高度差补偿回 scrollTop。 */
export interface ScrollRestoreState {
  height: number;
  top: number;
}

/** 会话消息取数参数（`useChatSessionState` 的 `buildFetchParams` 产物）。 */
export type ChatSessionFetchParams = SessionRequestParams & {
  provider: SessionProvider;
  projectName: string;
  projectPath: string;
};

export interface UseChatPaginationScrollArgs {
  /** 已投影成渲染消息的当前会话消息（只用其 length 作为「内容变了」的信号）。 */
  chatMessages: ChatMessage[];
  /** 当前滚动位置快照的键（`project:session`），null = 还没进入任何会话。 */
  activeScrollKey: string | null;
  isLoadingSessionMessages: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  buildFetchParams: (project: Project) => ChatSessionFetchParams;
  sessionStore: SessionStore;
  /** 搜索定位正在进行中（由主 hook 的搜索逻辑置位）：置位期间不做任何自动滚动。 */
  searchScrollActiveRef: MutableRefObject<boolean>;
}

export function useChatPaginationScroll({
  chatMessages,
  activeScrollKey,
  isLoadingSessionMessages,
  selectedProject,
  selectedSession,
  currentSessionId,
  buildFetchParams,
  sessionStore,
  searchScrollActiveRef,
}: UseChatPaginationScrollArgs) {
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const conversationScrollPositionsRef = useRef(new Map<string, ConversationScrollPosition>());
  const pendingConversationScrollRestoreRef = useRef<{
    key: string;
    position: ConversationScrollPosition;
  } | null>(null);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followScrollFrameRef = useRef<number | null>(null);
  // 用户上滑意图的**实时**副本：跟随帧要到下一帧才跑，而那正是「这一帧里用户有没有上滑」
  // 要回答的时刻，读 state 只会拿到调度那一刻的旧值（issue #468 ②）。
  const isUserScrolledUpRef = useRef(false);

  useEffect(
    () => () => {
      if (followScrollFrameRef.current !== null) {
        cancelAnimationFrame(followScrollFrameRef.current);
        followScrollFrameRef.current = null;
      }
    },
    [],
  );

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (followScrollFrameRef.current !== null) {
      return;
    }
    followScrollFrameRef.current = requestAnimationFrame(() => {
      followScrollFrameRef.current = null;
      // 帧已排队、但用户在这一帧里上滑了：撤销这次跟随，不把视口拽回底部（issue #468 ②）。
      if (isUserScrolledUpRef.current) return;
      scrollToBottom();
    });
  }, [scrollToBottom]);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  // 上滑态的唯一写入口：state 给渲染用，ref 给「下一帧才跑」的回调读。外部（发送消息时
  // 重置上滑态）也经返回对象调用它，所以两者不会分叉。
  const trackUserScrolledUp = useCallback((isScrolledUp: boolean) => {
    isUserScrolledUpRef.current = isScrolledUp;
    setIsUserScrolledUp(isScrolledUp);
  }, []);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return isScrollNearBottom(scrollTop, scrollHeight, clientHeight);
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          ...buildFetchParams(selectedProject),
          limit: MESSAGES_PER_PAGE,
        });
        if (!slot || slot.serverMessages.length === 0) return false;

        pendingScrollRestoreRef.current = { height: previousScrollHeight, top: previousScrollTop };
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        setVisibleMessageCount(prev => prev + MESSAGES_PER_PAGE);
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [buildFetchParams, hasMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (activeScrollKey) {
      conversationScrollPositionsRef.current.set(activeScrollKey, {
        top: container.scrollTop,
        distanceFromBottom: Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight),
      });
    }

    const nearBottom = isNearBottom();
    trackUserScrolledUp(!nearBottom);

    if (!allMessagesLoadedRef.current) {
      const scrolledNearTop = container.scrollTop < 100;
      if (!scrolledNearTop) {
        topLoadLockRef.current = false;
        return;
      }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [activeScrollKey, isNearBottom, loadOlderMessages, trackUserScrolledUp]);

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) return;
    const { height, top } = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = top + Math.max(newScrollHeight - height, 0);
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  // Reset scroll/pagination state on session change
  useLayoutEffect(() => {
    const savedScrollPosition = activeScrollKey
      ? (conversationScrollPositionsRef.current.get(activeScrollKey) ?? null)
      : null;
    pendingConversationScrollRestoreRef.current =
      activeScrollKey && savedScrollPosition ? { key: activeScrollKey, position: savedScrollPosition } : null;
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = !savedScrollPosition;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    trackUserScrolledUp(
      Boolean(savedScrollPosition && savedScrollPosition.distanceFromBottom > CONVERSATION_SCROLL_BOTTOM_THRESHOLD),
    );
  }, [activeScrollKey, searchScrollActiveRef, trackUserScrolledUp]);

  useLayoutEffect(() => {
    const pendingRestore = pendingConversationScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    if (
      !pendingRestore ||
      pendingRestore.key !== activeScrollKey ||
      !container ||
      isLoadingSessionMessages ||
      chatMessages.length === 0
    ) {
      return;
    }

    container.scrollTop = resolveConversationScrollTop(
      pendingRestore.position,
      container.scrollHeight,
      container.clientHeight,
    );
    pendingConversationScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = false;
  }, [activeScrollKey, chatMessages.length, isLoadingSessionMessages]);

  // Initial scroll to bottom
  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    // 还没有内容可滚（容器在消息为空时就已挂载，占位符渲染在它内部）。这条待办是**一次性**的：
    // 在这里消费掉就等于把「首屏落底」静默丢弃，消息真正到达时它已经不在了（issue #468 ①）。
    if (chatMessages.length === 0) return;
    pendingInitialScrollRef.current = false;
    if (!searchScrollActiveRef.current) {
      setTimeout(() => {
        // 首屏落底是延时执行的，执行时刻的用户意图只能从实时副本读——用户在这段延时里上滑了，
        // 这次落底必须让位（与跟随帧同一判据，issue #468）。
        if (isUserScrolledUpRef.current) return;
        scrollToBottom();
      }, UI_TIMEOUTS.CHAT_RELOAD_SCROLL_SETTLE_MS);
    }
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom, searchScrollActiveRef]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        ...buildFetchParams(selectedProject),
        limit: null,
        offset: 0,
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (container) {
          pendingScrollRestoreRef.current = { height: previousScrollHeight, top: previousScrollTop };
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
        }, UI_TIMEOUTS.LOAD_ALL_FINISHED_STATE_RESET_MS);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      logError("Error loading all messages:", error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [buildFetchParams, selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount(prev => prev + 100);
  }, []);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  /**
   * 会话切换 / 重新加载会话时的分页重置。
   * = 拆分前主 hook 会话加载 effect 里那一段连续赋值，原样搬来（逐 token 相同），
   * 只把「调用点」从内联改成一次调用；`setViewHiddenCount(0)` 不属于分页，仍留在主 hook。
   */
  const resetPagination = useCallback(() => {
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
  }, []);

  return {
    hasMoreMessages,
    setHasMoreMessages,
    totalMessages,
    setTotalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp: trackUserScrolledUp,
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
  };
}
