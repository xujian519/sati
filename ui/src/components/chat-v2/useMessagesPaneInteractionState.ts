import { useCallback, useRef, useState } from "react";
import { getIntrinsicMessageKey } from "../chat/utils/messageKeys";
import type { ChatMessage } from "../chat/types/types";
import type { RenderableItemsCache } from "./messagesPaneTypes";

export function useMessagesPaneInteractionState() {
  const messageKeyMapRef = useRef<WeakMap<ChatMessage, string>>(new WeakMap());
  const generatedMessageKeyCounterRef = useRef(0);
  // P3-4 增量缓存：{消息前缀, isAssistantWorking, 构建结果}。命中时返回缓存引用，
  // 使 renderableMessageItems 引用在流式 process tick 间稳定（见 useRenderableMessageTimeline）。
  const renderableItemsCacheRef = useRef<RenderableItemsCache | null>(null);
  const [expandedProcessRows, setExpandedProcessRows] = useState<Map<string, boolean>>(() => new Map());
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);

  const handleOpenSubagentDetail = useCallback((subagentId: string) => {
    setOpenSubagentId(subagentId);
  }, []);

  const getMessageKey = useCallback((message: ChatMessage, index: number) => {
    const existingKey = messageKeyMapRef.current.get(message);
    if (existingKey) return existingKey;

    const intrinsicKey = getIntrinsicMessageKey(message);
    if (intrinsicKey) {
      messageKeyMapRef.current.set(message, intrinsicKey);
      return intrinsicKey;
    }

    generatedMessageKeyCounterRef.current += 1;
    const candidateKey = `message-generated-${index}-${generatedMessageKeyCounterRef.current}`;
    messageKeyMapRef.current.set(message, candidateKey);
    return candidateKey;
  }, []);

  const isProcessExpanded = useCallback(
    (processKey: string, defaultExpanded = false) => expandedProcessRows.get(processKey) ?? defaultExpanded,
    [expandedProcessRows],
  );

  const handleProcessExpandedChange = useCallback((processKey: string, expanded: boolean) => {
    setExpandedProcessRows(currentRows => {
      const currentExpanded = currentRows.get(processKey) ?? false;
      if (currentExpanded === expanded) {
        return currentRows;
      }

      const nextRows = new Map(currentRows);
      if (expanded) {
        nextRows.set(processKey, true);
      } else {
        nextRows.delete(processKey);
      }
      return nextRows;
    });
  }, []);

  return {
    renderableItemsCacheRef,
    openSubagentId,
    setOpenSubagentId,
    handleOpenSubagentDetail,
    getMessageKey,
    isProcessExpanded,
    handleProcessExpandedChange,
  };
}
