import { useCallback, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import type { ChatMessage, ClaudeWorkStatus, SatiWorkStatus } from "../types/types";
import type { Project, ProjectSession, SessionProvider } from "../../../types/app";
import type { SessionStore } from "../../../stores/useSessionStore";
import { createCachedDiffCalculator, type DiffCalculator } from "../utils/messageTransforms";
import { useChatPaginationScroll } from "./use-chat-pagination-scroll";
import { useChatProcessingStatus } from "./use-chat-processing-status";
import { useChatScrollAnchor } from "./use-chat-scroll-anchor";
import { useChatSearchNavigation } from "./use-chat-search-navigation";
import { useChatSessionIdentity } from "./use-chat-session-identity";
import { useChatSessionLifecycle } from "./use-chat-session-lifecycle";
import { useChatTokenUsage } from "./use-chat-token-usage";
import { chatMessageToNormalized, useChatTranscriptView } from "./use-chat-transcript-view";

// 纯函数随各自的一族搬到子 hook（issue #467），这里保留同一导出路径：
// 既有单元测试与调用方按 `./useChatSessionState` 取用不受影响。
export { didLoadedSessionChange } from "./use-chat-session-lifecycle";
export { hasEquivalentUserMessage, shouldRenderPendingBubble } from "./use-chat-transcript-view";

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

/**
 * 聊天主链路的顶层状态聚合点 —— `ChatInterfaceV2` 直接消费它的返回对象（**39 键、键序固定**）。
 *
 * issue #467 之后这里只剩**编排**与「跨族共享的状态/ref」，各族逻辑都在子 hook 里：
 *
 * | 关注点 | 归属 | 调用点为什么在这里 |
 * |---|---|---|
 * | 会话身份解析（`currentSessionId` + 渲染期镜像） | `use-chat-session-identity` | 一切派生都依赖它，必须最先调用 |
 * | 消息视图（投影 + 乐观气泡 + 增删/回退） | `use-chat-transcript-view` | 必须在「乐观气泡 flush」之后、分页之前 |
 * | 分页窗口 + 滚动定位（含全量加载） | `use-chat-pagination-scroll`（内嵌 `use-chat-load-all`） | 5 条 effect 要排在会话加载/搜索定位之前 |
 * | 会话加载 + 外部消息刷新 | `use-chat-session-lifecycle` | 紧跟分页的 5 条 effect |
 * | 搜索定位 | `use-chat-search-navigation` | 夹在会话加载与 token 用量之间 |
 * | token 用量 | `use-chat-token-usage` | 原顺序里排在搜索定位之后、锚定之前 |
 * | 滚动锚定 | `use-chat-scroll-anchor` | 必须排在上述 effect 之后（读它们的滚动副作用） |
 * | 处理中状态 + 轮询 + 遮罩收起 | `use-chat-processing-status` | 三条紧接锚定之后 |
 *
 * 调用点次序即 effect 展开次序：拆分前 17 条 effect 与拆分后的展开顺序**索引一一对应**
 * （见 `docs/notes/implemented/2026-09-20-chat-session-state-full-decomposition.md`）。
 */
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
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeWorkStatus | null>(null);
  const [satiStatus, setSatiStatus] = useState<SatiWorkStatus | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);

  const searchScrollActiveRef = useRef(false);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  // 会话身份（`currentSessionId` 及其渲染期镜像）：必须在一切派生之前。
  // `liveSessionIdRef` 是同一份身份的**实时**副本，交给分页 hook 作在途取数的丢弃判据（issue #476）。
  const {
    currentSessionId,
    setCurrentSessionId,
    liveSessionIdRef,
    activeSessionId,
    activeScrollKey,
    sessionIsReadOnly,
    sessionRequestParams,
  } = useChatSessionIdentity({ selectedProject, selectedSession, pendingViewSessionRef });

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

  // 消息视图（投影 + 乐观气泡 + 增删/回退）。调用点即语义：它在「气泡 flush」之后读同一个
  // store，且分页 hook 需要它产出的 chatMessages。
  const { chatMessages, activityMessages, addMessage, clearMessages, rewindMessages, setViewHiddenCount } =
    useChatTranscriptView({
      sessionStore,
      activeSessionId,
      pendingUserMessage,
      setPendingUserMessage,
      pendingViewSessionRef,
    });

  /* ---------------------------------------------------------------- */
  /*  分页窗口 + 滚动定位（#159 N02 拆到 useChatPaginationScroll）        */
  /* ---------------------------------------------------------------- */

  // 调用点位置就是语义：本 hook 的 effect（加载后保持位置 / 会话切换复位 /
  // 会话内位置恢复 / 首屏落底）在拆分前就排在下面的「会话加载 effect」与更下方的
  // 「搜索定位 effect」之前——`pendingInitialScrollRef` 与 `searchScrollActiveRef`
  // 的读写次序决定首屏是否落到底、搜索跳转时是否被抢滚动。不要把它挪到它们之后。
  const pagination = useChatPaginationScroll({
    chatMessages,
    activeScrollKey,
    isLoadingSessionMessages,
    selectedSession,
    selectedProject,
    liveSessionIdRef,
    buildFetchParams,
    sessionStore,
    searchScrollActiveRef,
  });

  // 会话生命周期（会话加载 + 外部消息刷新）外置到 ./use-chat-session-lifecycle（issue #467）。
  // 调用点即语义：这两条 effect 在拆分前就紧跟分页 hook 的 5 条 effect。
  useChatSessionLifecycle({
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
    messagesOffsetRef: pagination.messagesOffsetRef,
    resetStreamingState,
    resetPagination: pagination.resetPagination,
    setIsLoadingSessionMessages,
    setHasMoreMessages: pagination.setHasMoreMessages,
    setTotalMessages: pagination.setTotalMessages,
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
    isNearBottom: pagination.isNearBottom,
    scrollToBottom: pagination.scrollToBottom,
  });

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
    allMessagesLoadedRef: pagination.allMessagesLoadedRef,
    messagesOffsetRef: pagination.messagesOffsetRef,
    scrollContainerRef: pagination.scrollContainerRef,
    setAllMessagesLoaded: pagination.setAllMessagesLoaded,
    setHasMoreMessages: pagination.setHasMoreMessages,
    setTotalMessages: pagination.setTotalMessages,
    setVisibleMessageCount: pagination.setVisibleMessageCount,
    searchScrollActiveRef,
    pendingViewSessionRef,
  });

  // token 用量外置到 ./use-chat-token-usage（issue #467）：它单独一个调用点是为了让
  // effect 展开顺序与拆分前逐条对应（原顺序里它排在搜索定位之后、锚定之前）。
  useChatTokenUsage({
    selectedProject,
    selectedSession,
    sessionIsReadOnly,
    setTokenBudget,
  });

  const streamContentKey = useMemo(() => getStreamContentKey(pagination.visibleMessages), [pagination.visibleMessages]);

  // 滚动锚定（跟随底部 / 增长时保住阅读位置 / 绑定 scroll 监听）。
  // 同样地，调用点即语义：这三条 effect 必须排在「会话加载」与「搜索定位」之后，
  // 它们会把 searchScrollActiveRef 置位、把 scrollTop 挪走，锚定快照取决于此。
  useChatScrollAnchor({
    autoScrollToBottom,
    chatMessages,
    streamContentKey,
    isUserScrolledUp: pagination.isUserScrolledUp,
    scrollContainerRef: pagination.scrollContainerRef,
    scrollPositionRef: pagination.scrollPositionRef,
    isLoadingMoreRef: pagination.isLoadingMoreRef,
    pendingScrollRestoreRef: pagination.pendingScrollRestoreRef,
    searchScrollActiveRef,
    scheduleScrollToBottom: pagination.scheduleScrollToBottom,
    handleScroll: pagination.handleScroll,
  });

  // 「处理中」状态与轮询外置到 ./use-chat-processing-status（issue #467）：这三条 effect
  // 在拆分前就是紧接着滚动锚定的三条（M7–M9），调用点保持在锚定之后。
  useChatProcessingStatus({
    selectedSession,
    currentSessionId,
    pendingViewSessionRef,
    sessionIsReadOnly,
    processingSessions,
    isLoading,
    setIsLoading,
    setCanAbortSession,
    ws,
    sendMessage,
    hasMoreMessages: pagination.hasMoreMessages,
    setShowLoadAllOverlay: pagination.setShowLoadAllOverlay,
  });

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
    hasMoreMessages: pagination.hasMoreMessages,
    totalMessages: pagination.totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting,
    setIsAborting,
    isUserScrolledUp: pagination.isUserScrolledUp,
    setIsUserScrolledUp: pagination.setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount: pagination.visibleMessageCount,
    visibleMessages: pagination.visibleMessages,
    loadEarlierMessages: pagination.loadEarlierMessages,
    loadAllMessages: pagination.loadAllMessages,
    allMessagesLoaded: pagination.allMessagesLoaded,
    isLoadingAllMessages: pagination.isLoadingAllMessages,
    loadAllJustFinished: pagination.loadAllJustFinished,
    showLoadAllOverlay: pagination.showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    satiStatus,
    setSatiStatus,
    createDiff,
    scrollContainerRef: pagination.scrollContainerRef,
    scrollToBottom: pagination.scrollToBottom,
    scrollToBottomAndReset: pagination.scrollToBottomAndReset,
    isNearBottom: pagination.isNearBottom,
    handleScroll: pagination.handleScroll,
  };
}
