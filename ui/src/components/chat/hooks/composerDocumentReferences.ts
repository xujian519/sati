import type { Dispatch, RefObject, SetStateAction } from "react";
import { normalizeContentReference, type ContentReference } from "../../../types/contentReference";

/**
 * 预览面板 → composer 的引用入口：监听 `sati:add-chat-reference`，去重后写入引用列表。
 *
 * 从 `useChatComposerState.ts` 搬出（#646 B2.5），**被搬代码逐字未改**；
 * 挂载位置与依赖数组保持不变。
 */

type AddChatReferenceOptions = {
  setDocumentReferences: Dispatch<SetStateAction<ContentReference[]>>;
  syncQueuedBusySendSnapshot: (updates: { documentReferences?: ContentReference[] }) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function attachAddChatReferenceListener({
  setDocumentReferences,
  syncQueuedBusySendSnapshot,
  textareaRef,
}: AddChatReferenceOptions): () => void {
  const handleAddDocumentReference = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const reference = normalizeContentReference(detail);
    if (!reference) return;
    setDocumentReferences(previous => {
      if (previous.some(item => item.id === reference.id)) return previous;
      const next = [...previous, reference];
      syncQueuedBusySendSnapshot({ documentReferences: next });
      return next;
    });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  window.addEventListener("sati:add-chat-reference", handleAddDocumentReference);
  return () => {
    window.removeEventListener("sati:add-chat-reference", handleAddDocumentReference);
  };
}
