import type { ContentReference } from "../../../types/contentReference";

/**
 * 忙碌队列的「待补发快照」：排队期间附件/引用/输入的实时快照。
 *
 * 从 `useChatComposerState.ts` 搬出（#646 B2.5），**合并逻辑逐字未改**。
 */

export type QueuedBusySendSnapshot = {
  input: string;
  attachedImages: File[];
  documentReferences: ContentReference[];
  forceStart?: boolean;
};

type SnapshotFallback = {
  input: string;
  attachedImages: File[];
  documentReferences: ContentReference[];
};

export function mergeQueuedBusySendSnapshot(
  previous: QueuedBusySendSnapshot | null,
  updates: Partial<QueuedBusySendSnapshot>,
  fallback: SnapshotFallback,
): QueuedBusySendSnapshot {
  return {
    input: updates.input ?? previous?.input ?? fallback.input,
    attachedImages: updates.attachedImages ?? previous?.attachedImages ?? fallback.attachedImages,
    documentReferences: updates.documentReferences ?? previous?.documentReferences ?? fallback.documentReferences,
    ...(previous?.forceStart ? { forceStart: true } : {}),
    ...(updates.forceStart ? { forceStart: true } : {}),
  };
}
