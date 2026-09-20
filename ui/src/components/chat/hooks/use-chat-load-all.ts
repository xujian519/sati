import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import { logError } from "../../../utils/logging";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { Project, ProjectSession } from "../../../types/app";
import type { SessionStore } from "../../../stores/useSessionStore";
import { INITIAL_VISIBLE_MESSAGES } from "./chat-pagination-window";
import type { ChatSessionFetchParams, ScrollRestoreState } from "./use-chat-pagination-scroll";

/**
 * 「加载全部消息」一族 —— 从 `useChatPaginationScroll` 拆出的独立 hook（issue #467）。
 *
 * 这里只做**搬家**，语义与拆分前逐 token 等价：`loadAllMessages` 拉全量、`scrollToBottomAndReset`
 * 退出全量态、`resetLoadAll` 在会话切换时把这族状态收回初始值。
 *
 * 依赖方向是单向的：调用方（`useChatPaginationScroll`）持有分页游标与滚动容器 ref，本 hook
 * **不复制**它们，只经参数读写；`allMessagesLoadedRef` 由本 hook 持有并被分页侧读（「已全量
 * 加载就不再分页」），因此调用点在分页 hook 内部、`handleScroll` 之前。
 */

export interface UseChatLoadAllArgs {
  /** 把容器直接推到底（`useChatPaginationScroll` 的 `scrollToBottom`，身份恒定）。 */
  scrollToBottom: () => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** 全量加载前量取的容器指标，commit 后按高度差补偿回 scrollTop。 */
  pendingScrollRestoreRef: MutableRefObject<ScrollRestoreState | null>;
  /** 分页/全量共用的一把锁：任一在途取数期间不重复发起。 */
  isLoadingMoreRef: MutableRefObject<boolean>;
  messagesOffsetRef: MutableRefObject<number>;
  setHasMoreMessages: (value: boolean) => void;
  setTotalMessages: (value: number) => void;
  setVisibleMessageCount: Dispatch<SetStateAction<number>>;
  sessionStore: SessionStore;
  buildFetchParams: (project: Project) => ChatSessionFetchParams;
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
  currentSessionId: string | null;
}

export function useChatLoadAll({
  scrollToBottom,
  scrollContainerRef,
  pendingScrollRestoreRef,
  isLoadingMoreRef,
  messagesOffsetRef,
  setHasMoreMessages,
  setTotalMessages,
  setVisibleMessageCount,
  sessionStore,
  buildFetchParams,
  selectedSession,
  selectedProject,
  currentSessionId,
}: UseChatLoadAllArgs) {
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  const allMessagesLoadedRef = useRef(false);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom, setVisibleMessageCount]);

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
  }, [
    buildFetchParams,
    selectedSession,
    selectedProject,
    isLoadingAllMessages,
    currentSessionId,
    sessionStore,
    scrollContainerRef,
    pendingScrollRestoreRef,
    isLoadingMoreRef,
    messagesOffsetRef,
    setHasMoreMessages,
    setTotalMessages,
    setVisibleMessageCount,
    allMessagesLoadedRef,
    loadAllFinishedTimerRef,
    setIsLoadingAllMessages,
    setShowLoadAllOverlay,
    setAllMessagesLoaded,
    setLoadAllJustFinished,
  ]);

  /**
   * 会话切换 / 重新加载会话时把「全量加载」这族状态收回初始值。
   * = 拆分前 `resetPagination` 里的那一段连续赋值，原样搬来（逐 token 相同，语句顺序不变），
   * 只把「调用点」从内联改成一次调用。
   */
  const resetLoadAll = useCallback(() => {
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
  }, [setAllMessagesLoaded, setShowLoadAllOverlay]);

  return {
    allMessagesLoaded,
    setAllMessagesLoaded,
    allMessagesLoadedRef,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    setShowLoadAllOverlay,
    loadAllMessages,
    scrollToBottomAndReset,
    resetLoadAll,
  };
}
