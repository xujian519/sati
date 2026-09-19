import { useEffect } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { ChatMessage } from "../types/types";
import type { ScrollRestoreState } from "./use-chat-pagination-scroll";

/**
 * 滚动锚定 —— 从 `useChatSessionState` 拆出的独立 hook（#159 TD-UI-CHAT-N02）。
 *
 * 负责「内容增长时视口落在哪」：每次提交前给容器拍一份指标快照，
 * 内容长高时（`streamContentKey` / 消息条数变化）要么跟随底部、要么把新增高度
 * 补偿回 scrollTop 保住读者的阅读位置；并绑定 `scroll` 监听。
 *
 * ⚠️ 调用点在主 hook 里**必须在会话加载 effect 与搜索定位 effect 之后**：
 * 这几条 effect 会置 `searchScrollActiveRef` / 改 `scrollTop`，锚定 effect 读到的
 * 快照取决于它们在 effect 队列里的先后。参数里的 state/ref 都由
 * `useChatPaginationScroll` 持有，本 hook 不另建副本。
 */
export interface UseChatScrollAnchorArgs {
  autoScrollToBottom?: boolean;
  chatMessages: ChatMessage[];
  streamContentKey: string;
  isUserScrolledUp: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollPositionRef: MutableRefObject<ScrollRestoreState>;
  isLoadingMoreRef: MutableRefObject<boolean>;
  pendingScrollRestoreRef: MutableRefObject<ScrollRestoreState | null>;
  searchScrollActiveRef: MutableRefObject<boolean>;
  scheduleScrollToBottom: () => void;
  handleScroll: () => Promise<void>;
}

export function useChatScrollAnchor({
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
}: UseChatScrollAnchorArgs) {
  useEffect(() => {
    if (!autoScrollToBottom && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
    }
  });

  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current) return;

    if (autoScrollToBottom) {
      if (!isUserScrolledUp) scheduleScrollToBottom();
      return;
    }

    const container = scrollContainerRef.current;
    const prevHeight = scrollPositionRef.current.height;
    const prevTop = scrollPositionRef.current.top;
    const newHeight = container.scrollHeight;
    const heightDiff = newHeight - prevHeight;
    if (heightDiff > 0 && prevTop > 0) container.scrollTop = prevTop + heightDiff;
  }, [
    autoScrollToBottom,
    chatMessages.length,
    isUserScrolledUp,
    scheduleScrollToBottom,
    streamContentKey,
    isLoadingMoreRef,
    pendingScrollRestoreRef,
    scrollContainerRef,
    scrollPositionRef,
    searchScrollActiveRef,
  ]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll, scrollContainerRef]);
}
