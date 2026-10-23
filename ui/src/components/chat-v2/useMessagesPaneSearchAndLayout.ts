import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { recordUiDiagnostic } from "../../lib/uiDiagnostics";
import { UI_TIMEOUTS } from "../../constants/timeouts";
import type { ChatMessage } from "../chat/types/types";
import type { SearchableChatMessageInput } from "./chatHistorySearchUtils";
import type { VirtualMessageWindow } from "./messageVirtualization";
import { useChatHistorySearch } from "./useChatHistorySearch";
import { useRegisterChatHistorySearchControls } from "./ChatHistorySearchController";
import type { KeyedRenderableMessageItem } from "./messagesPaneTypes";

type UseMessagesPaneSearchAndLayoutOptions = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  keyedMessageItems: KeyedRenderableMessageItem[];
  measuredItemHeights: number[];
  allMessagesLoaded: boolean;
  hasMoreMessages: boolean;
  loadAllMessages: () => void;
  sessionId: string | null;
  virtualWindow: VirtualMessageWindow;
  isAssistantWorking: boolean;
  isLoadingSessionMessages: boolean;
  chatMessages: ChatMessage[];
  shouldVirtualizeMessages: boolean;
};

export function useMessagesPaneSearchAndLayout({
  scrollContainerRef,
  keyedMessageItems,
  measuredItemHeights,
  allMessagesLoaded,
  hasMoreMessages,
  loadAllMessages,
  sessionId,
  virtualWindow,
  isAssistantWorking,
  isLoadingSessionMessages,
  chatMessages,
  shouldVirtualizeMessages,
}: UseMessagesPaneSearchAndLayoutOptions) {
  const keyedMessagesForSearch = useMemo<SearchableChatMessageInput[]>(() => {
    return keyedMessageItems.map(item => ({
      message: item.message,
      messageKey: item.itemKey,
      messageIndex: item.renderIndex,
    }));
  }, [keyedMessageItems]);

  const chatHistorySearch = useChatHistorySearch({
    scrollContainerRef,
    keyedMessages: keyedMessagesForSearch,
    measuredItemHeights,
    allMessagesLoaded,
    hasMoreMessages,
    loadAllMessages,
    sessionId,
    renderWindowKey: `${virtualWindow.startIndex}:${virtualWindow.endIndex}`,
  });
  const searchIsRenderedByShell = useRegisterChatHistorySearchControls(chatHistorySearch);
  const [hasLayoutWarning, setHasLayoutWarning] = useState(false);
  useEffect(() => {
    setHasLayoutWarning(false);
    if (isAssistantWorking || isLoadingSessionMessages || keyedMessageItems.length === 0) return;
    // 等布局稳定后再判定。隐藏标签页/面板、空会话都不算渲染故障（上游 #568）。
    // 依赖只放稳定的标量签名：放进 keyedMessageItems 的数组身份或滚动窗口会让
    // 流式输出/滚动期间每次渲染都重置计时器，"稳定后 800ms" 永不成立，探测形同虚设。
    // 依赖不含滚动 → 触发时不再读当时的虚拟窗口（已过期），改读实时 DOM 行数。
    const timer = window.setTimeout(() => {
      const node = scrollContainerRef.current;
      if (!node || node.clientHeight <= 0 || !node.getClientRects().length || document.visibilityState === "hidden") {
        return;
      }
      const viewport = node.getBoundingClientRect();
      const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-message-key]"));
      const hasVisibleRow = rows.some(row => {
        const rect = row.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      if (hasVisibleRow) return;
      // 只记计数/位置，不落消息内容（诊断缓冲不得含 prompt / 正文）。
      recordUiDiagnostic("chat-empty-viewport", {
        messages: chatMessages.length,
        renderItems: keyedMessageItems.length,
        renderedRows: rows.length,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        viewportHeight: node.clientHeight,
        virtualized: shouldVirtualizeMessages,
      });
      setHasLayoutWarning(true);
    }, UI_TIMEOUTS.LAYOUT_STABILITY_PROBE_MS);
    return () => window.clearTimeout(timer);
  }, [
    isAssistantWorking,
    isLoadingSessionMessages,
    keyedMessageItems.length,
    chatMessages.length,
    scrollContainerRef,
    shouldVirtualizeMessages,
  ]);

  return { chatHistorySearch, searchIsRenderedByShell, hasLayoutWarning };
}
