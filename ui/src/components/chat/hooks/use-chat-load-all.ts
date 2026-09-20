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
import { isFetchForOtherSession } from "./use-chat-session-identity";

/**
 * 「加载全部消息」一族 —— 从 `useChatPaginationScroll` 拆出的独立 hook（issue #467）。
 *
 * 主体是**搬家**：`loadAllMessages` 拉全量、`scrollToBottomAndReset`
 * 退出全量态、`resetLoadAll` 在会话切换时把这族状态收回初始值。issue #476 只改了一处：
 * 在途请求返回时的丢弃判据改为读实时会话身份，并把请求前自己置位的标记在丢弃路径上复归。
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
  /**
   * 实时会话身份（`useChatSessionIdentity` 每次渲染镜像，经分页 hook 下传）。请求返回时要判
   * 「这批全量还算不算当前会话的」，而 `loadAllMessages` 是 useCallback —— 依赖变化只让
   * **后续调用**拿到新闭包，在途那次仍读旧值，直接比 `currentSessionId` 等于永远相等
   * （issue #476）。判据读这个副本。
   */
  liveSessionIdRef: MutableRefObject<string | null>;
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
  liveSessionIdRef,
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

      // 会话在请求在途时已被切走（切到别的会话或退回欢迎页）：这批结果属于旧会话，丢弃。
      // 丢弃路径要把请求前自己置位的标记收回，否则新会话会停在「已全量加载」的假状态上。
      if (isFetchForOtherSession(liveSessionIdRef, requestSessionId)) {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
        return;
      }

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
    // `liveSessionIdRef` 由 ./use-chat-session-identity 持有、经分页 hook 下传：ref 对象
    // 身份恒定，列入依赖只为满足 exhaustive-deps，重跑时机不变。
    liveSessionIdRef,
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
