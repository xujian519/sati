import { useMemo } from "react";
import type { RefObject } from "react";
import type { ChatMessage, ChatRunMode } from "../chat/types/types";
import type { SessionStore } from "../../stores/useSessionStore";
import { getSessionRequestParams, type ProjectSession } from "../../types/app";
import { estimateMessageItemHeight, useMessageVirtualization } from "./messageVirtualization";
import { useSubagentMessages } from "./useSubagentMessages";
import {
  buildRenderableMessageItems,
  getLastMessageTurnStart,
  getLiveProcessDetailMessages,
  getLiveProcessGroups,
  isEmptyAssistantShell,
  isProcessMessage,
  shouldRenderLiveProcessGroup,
  type LiveProcessGroup,
} from "./processGrouping";
import { isStreamingThinkingMessage, isSubagentThinkingPlaceholder } from "./messagesPaneHelpers";
import type { KeyedRenderableMessageItem, RenderableItemsCache } from "./messagesPaneTypes";

type UseRenderableMessageTimelineOptions = {
  selectedSession: ProjectSession | null;
  openSubagentId: string | null;
  sessionId: string | null;
  projectPath: string | undefined;
  sessionStore: SessionStore | undefined;
  openSubagentActivityState: string | undefined;
  visibleMessages: ChatMessage[];
  showThinking: boolean | undefined;
  inlineThinking: boolean | undefined;
  isAssistantWorking: boolean;
  runMode: ChatRunMode;
  renderableItemsCacheRef: RefObject<RenderableItemsCache | null>;
  getMessageKey: (message: ChatMessage, index: number) => string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
};

export function useRenderableMessageTimeline({
  selectedSession,
  openSubagentId,
  sessionId,
  projectPath,
  sessionStore,
  openSubagentActivityState,
  visibleMessages,
  showThinking,
  inlineThinking,
  isAssistantWorking,
  runMode,
  renderableItemsCacheRef,
  getMessageKey,
  scrollContainerRef,
}: UseRenderableMessageTimelineOptions) {
  const sessionRequestParams = useMemo(() => getSessionRequestParams(selectedSession), [selectedSession]);
  const subagentDetail = useSubagentMessages(
    openSubagentId ? sessionId : null,
    openSubagentId,
    projectPath,
    sessionStore,
    openSubagentActivityState,
    sessionRequestParams,
  );
  const renderableMessages = useMemo(() => {
    const lastUserIndex = isAssistantWorking
      ? visibleMessages.reduce((lastIndex, message, index) => (message.type === "user" ? index : lastIndex), -1)
      : -1;
    const filtered = visibleMessages.filter(
      (message, index) =>
        !message.isAgentActivity &&
        !isSubagentThinkingPlaceholder(message) &&
        !(isAssistantWorking && message.isThinking && !message.isStreaming && index < lastUserIndex) &&
        !(!inlineThinking && isStreamingThinkingMessage(message)) &&
        !(message.isThinking && !showThinking),
    );
    return filtered;
  }, [visibleMessages, showThinking, inlineThinking, isAssistantWorking]);
  // 协议 1.7：定位最后一条可编辑 user 消息与最后一条可重新生成 assistant 消息
  // （流式中的候选不稳定，排除；entryId 缺失的历史行也不提供动作）。
  const lastTurnActionIndices = useMemo(() => {
    let userIndex = -1;
    let assistantIndex = -1;
    renderableMessages.forEach((message, index) => {
      if (message.isStreaming || !message.entryId) return;
      if (message.type === "user" && String(message.content ?? "").trim()) userIndex = index;
      if (message.type === "assistant" && String(message.content ?? "").trim()) assistantIndex = index;
    });
    return { userIndex, assistantIndex };
  }, [renderableMessages]);
  const liveProcessDetailMessages = useMemo(
    () => (isAssistantWorking ? getLiveProcessDetailMessages(renderableMessages) : []),
    [isAssistantWorking, renderableMessages],
  );
  const liveProcessGroups = useMemo(
    () =>
      isAssistantWorking
        ? getLiveProcessGroups(renderableMessages, { isAssistantWorking }).filter(group =>
            shouldRenderLiveProcessGroup(group, runMode),
          )
        : [],
    [isAssistantWorking, renderableMessages, runMode],
  );
  const liveProcessGroupsByAnchor = useMemo(() => {
    const groupsByAnchor = new Map<number, LiveProcessGroup[]>();
    for (const group of liveProcessGroups) {
      const groups = groupsByAnchor.get(group.afterOriginalIndex) || [];
      groups.push(group);
      groupsByAnchor.set(group.afterOriginalIndex, groups);
    }
    return groupsByAnchor;
  }, [liveProcessGroups]);
  const renderableMessageItems = useMemo(() => {
    const cached = renderableItemsCacheRef.current;
    if (
      cached !== null &&
      cached.isAssistantWorking === isAssistantWorking &&
      renderableMessages.length > cached.messages.length
    ) {
      const prev = cached.messages;
      let prefixMatches = true;
      for (let index = 0; index < prev.length; index += 1) {
        if (prev[index] !== renderableMessages[index]) {
          prefixMatches = false;
          break;
        }
      }
      if (prefixMatches) {
        // 增量安全条件（可证明输出不变）：
        //  a) 新增消息全部可折叠/过滤（process 消息被 live 折叠、shell 空壳被
        //     filter 移除）→ 不产生新 item；user/prose/流式 thinking 等
        //     → 可能产生 item，全量重算（保守）。
        //  b) 旧输出中最后 turn 无 item（liveTurn 的折叠判定依赖 liveTurn 内
        //     全部消息——新增 process 消息可能使旧 standalone thinking 组
        //     转为折叠，因此最后 turn 已有 item 时必须全量）。
        // 满足 a+b 时旧结果引用可直接复用，下游 keyedMessageItems /
        // measuredItemHeights / prefixOffsets 全部级联命中。
        let appendedOnlyCollapsible = true;
        for (let index = prev.length; index < renderableMessages.length; index += 1) {
          const message = renderableMessages[index];
          if (message && (isProcessMessage(message) || isEmptyAssistantShell(message))) continue;
          appendedOnlyCollapsible = false;
          break;
        }
        const lastTurnStart = getLastMessageTurnStart(prev);
        let lastTurnHasItems = false;
        for (let index = cached.result.length - 1; index >= 0; index -= 1) {
          if (cached.result[index].originalIndex < lastTurnStart) break;
          lastTurnHasItems = true;
          break;
        }
        if (appendedOnlyCollapsible && !lastTurnHasItems) {
          renderableItemsCacheRef.current = { messages: renderableMessages, isAssistantWorking, result: cached.result };
          return cached.result;
        }
      }
    }
    const result = buildRenderableMessageItems(renderableMessages, { isAssistantWorking });
    renderableItemsCacheRef.current = { messages: renderableMessages, isAssistantWorking, result };
    return result;
  }, [isAssistantWorking, renderableMessages, renderableItemsCacheRef]);
  const keyedMessageItems = useMemo<KeyedRenderableMessageItem[]>(
    () =>
      renderableMessageItems.map((item, index) => ({
        ...item,
        itemKey: getMessageKey(item.message, index),
        renderIndex: index,
        estimatedHeight: estimateMessageItemHeight(item),
      })),
    [getMessageKey, renderableMessageItems],
  );
  const {
    measuredItemHeights,
    shouldVirtualizeMessages,
    virtualWindow,
    windowedMessageItems,
    handleMeasuredItemHeight,
  } = useMessageVirtualization({ keyedItems: keyedMessageItems, scrollContainerRef });

  const liveProcessHeaderIndex = useMemo(() => {
    if (!isAssistantWorking) return -1;
    for (let index = keyedMessageItems.length - 1; index >= 0; index -= 1) {
      if (keyedMessageItems[index].message.type === "user") {
        return Math.min(index + 1, keyedMessageItems.length);
      }
    }
    return keyedMessageItems.length > 0 ? 0 : -1;
  }, [isAssistantWorking, keyedMessageItems]);
  // The current turn's "started at" is anchored to the latest user message's
  // timestamp (set by the composer when the user submits). This is the only
  // signal that survives a page refresh and reliably resets between turns —
  // activity-based timing is unreliable because `activityMessages` accumulates
  // across turns in the session store.
  const liveProcessStartedAtMs = useMemo(() => {
    if (!isAssistantWorking || liveProcessHeaderIndex <= 0) return null;
    const anchorMessage = keyedMessageItems[liveProcessHeaderIndex - 1]?.message;
    if (anchorMessage?.type !== "user" || anchorMessage.timestamp == null) return null;
    const parsed = Date.parse(String(anchorMessage.timestamp));
    return Number.isFinite(parsed) ? parsed : null;
  }, [isAssistantWorking, keyedMessageItems, liveProcessHeaderIndex]);
  const hasLiveAssistantContent = useMemo(() => {
    if (!isAssistantWorking || liveProcessHeaderIndex < 0) return false;
    return keyedMessageItems
      .slice(liveProcessHeaderIndex)
      .some(
        item =>
          item.message.type === "assistant" &&
          !item.message.isThinking &&
          !item.message.isToolUse &&
          typeof item.message.content === "string" &&
          item.message.content.trim().length > 0,
      );
  }, [isAssistantWorking, keyedMessageItems, liveProcessHeaderIndex]);
  const hasPendingToolUse = useMemo(() => {
    if (!isAssistantWorking || liveProcessHeaderIndex < 0) return false;
    const liveItems = keyedMessageItems.slice(liveProcessHeaderIndex);
    let lastToolUseIdx = -1;
    for (let index = liveItems.length - 1; index >= 0; index -= 1) {
      if (liveItems[index]?.message.isToolUse) {
        lastToolUseIdx = index;
        break;
      }
    }
    if (lastToolUseIdx < 0) return false;
    const hasContentAfterTool = liveItems
      .slice(lastToolUseIdx + 1)
      .some(
        item =>
          item.message.type === "assistant" &&
          !item.message.isThinking &&
          !item.message.isToolUse &&
          typeof item.message.content === "string" &&
          item.message.content.trim().length > 0,
      );
    return !hasContentAfterTool;
  }, [isAssistantWorking, keyedMessageItems, liveProcessHeaderIndex]);

  return {
    subagentDetail,
    renderableMessages,
    lastTurnActionIndices,
    liveProcessDetailMessages,
    liveProcessGroups,
    liveProcessGroupsByAnchor,
    renderableMessageItems,
    keyedMessageItems,
    measuredItemHeights,
    shouldVirtualizeMessages,
    virtualWindow,
    windowedMessageItems,
    handleMeasuredItemHeight,
    liveProcessHeaderIndex,
    liveProcessStartedAtMs,
    hasLiveAssistantContent,
    hasPendingToolUse,
  };
}
