import { type MutableRefObject, type RefObject, useEffect, useState } from "react";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { Project, ProjectSession } from "../../../types/app";
import type { SessionStore } from "../../../stores/useSessionStore";
import type { ChatMessage } from "../types/types";
import type { ChatSessionFetchParams } from "./use-chat-pagination-scroll";

/**
 * 历史搜索的定位与高亮 —— 从 `useChatSessionState` 拆出的独立 hook（issue #467）。
 *
 * 三条 effect 一起搬（它们共享 `searchTarget` 与 `searchScrollActiveRef`，且中间的
 * `pendingViewSessionRef` 复位必须在三者之间原位）：
 *
 * 1. 读 `selectedSession.__searchTargetSnippet` / `__searchTargetTimestamp` 置位搜索态；
 * 2. 进入真实会话时清掉「待建会话」交班标记；
 * 3. 先保证全量在手（未全量则拉全量并等渲染沉降），再反复重试找到目标元素，
 *    `scrollIntoView` + 闪烁高亮，最后清掉搜索态。
 *
 * ⚠️ 调用点在主 hook 里**必须在会话加载 effect 之后、滚动锚定之前**：`searchScrollActiveRef`
 * 由这里置位、被分页 hook 的「首屏落底」与锚定 hook 读，次序决定搜索跳转时会不会被抢滚动。
 * 单一真源：`searchScrollActiveRef` 仍由主 hook 持有（分页与锚定也要用），本 hook 只增删不改。
 */

export interface UseChatSearchNavigationArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
  sessionStore: SessionStore;
  buildFetchParams: (project: Project) => ChatSessionFetchParams;
  /** 当前会话的渲染消息（只用其 length 作为「内容变了」的信号）。 */
  chatMessages: ChatMessage[];
  isLoadingSessionMessages: boolean;
  allMessagesLoadedRef: MutableRefObject<boolean>;
  messagesOffsetRef: MutableRefObject<number>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  setAllMessagesLoaded: (value: boolean) => void;
  setHasMoreMessages: (value: boolean) => void;
  setTotalMessages: (value: number) => void;
  setVisibleMessageCount: (value: number | ((prev: number) => number)) => void;
  /** 搜索定位正在进行中：置位期间不做任何自动滚动（由分页/锚定 hook 读）。 */
  searchScrollActiveRef: MutableRefObject<boolean>;
  /** 主 hook 的「待建会话」标记：进入真实会话后清掉。 */
  pendingViewSessionRef: MutableRefObject<{ sessionId: string | null; startedAt: number } | null>;
}

export function useChatSearchNavigation({
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
}: UseChatSearchNavigationArgs) {
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(
    null,
  );

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === "string" && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === "string" ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession, searchScrollActiveRef]);

  useEffect(() => {
    if (selectedSession?.id) pendingViewSessionRef.current = null;
  }, [pendingViewSessionRef, selectedSession?.id]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
        try {
          const slot = await sessionStore.fetchFromServer(selectedSession.id, {
            ...buildFetchParams(selectedProject),
            limit: null,
            offset: 0,
          });
          if (slot) {
            setHasMoreMessages(false);
            setTotalMessages(slot.total);
            messagesOffsetRef.current = slot.total;
            setVisibleMessageCount(Infinity);
            setAllMessagesLoaded(true);
            allMessagesLoadedRef.current = true;
            await new Promise(resolve => setTimeout(resolve, UI_TIMEOUTS.CHAT_FULL_LOAD_RENDER_SETTLE_MS));
          }
        } catch {
          // Fall through and scroll in current messages
        }
      }
      setVisibleMessageCount(Infinity);

      const findAndScroll = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet
            .replace(/^\.{3}/, "")
            .replace(/\.{3}$/, "")
            .trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll(".chat-message");
            for (const el of messageElements) {
              const text = (el.textContent || "").toLowerCase();
              if (text.includes(searchPhrase)) {
                targetElement = el;
                break;
              }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll("[data-message-timestamp]");
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute("data-message-timestamp");
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) {
              closestDiff = diff;
              targetElement = el;
            }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: "center", behavior: "smooth" });
          targetElement.classList.add("search-highlight-flash");
          setTimeout(
            () => targetElement?.classList.remove("search-highlight-flash"),
            UI_TIMEOUTS.SEARCH_HIGHLIGHT_FLASH_MS,
          );
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), UI_TIMEOUTS.SEARCH_SCROLL_RETRY_INTERVAL_MS);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      setTimeout(() => findAndScroll(15), UI_TIMEOUTS.SEARCH_SCROLL_INITIAL_DELAY_MS);
    };

    scrollToTarget();
  }, [
    buildFetchParams,
    chatMessages.length,
    isLoadingSessionMessages,
    searchTarget,
    selectedProject,
    selectedSession,
    sessionStore,
    allMessagesLoadedRef,
    messagesOffsetRef,
    scrollContainerRef,
    searchScrollActiveRef,
    setAllMessagesLoaded,
    setHasMoreMessages,
    setTotalMessages,
    setVisibleMessageCount,
  ]);
}
