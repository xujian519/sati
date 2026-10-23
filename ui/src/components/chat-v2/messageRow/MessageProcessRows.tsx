import { useMemo, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import type { ChatMessage } from "../../chat/types/types";
import ImageLightbox, { type LightboxImage } from "../../chat/view/subcomponents/ImageLightbox";
import { ProcessTrace } from "../ProcessTrace";
import { processSummaryToTrace, type ProcessAttachment } from "../processGrouping";

export function ProcessSummaryRow({
  message,
  processKey,
  detailMessages = [],
  renderDetailMessage,
  isProcessExpanded,
  onProcessExpandedChange,
  t,
}: {
  message: ChatMessage;
  processKey?: string;
  detailMessages?: ChatMessage[];
  renderDetailMessage?: (message: ChatMessage, index: number) => ReactNode;
  isProcessExpanded?: (processKey: string, defaultExpanded?: boolean) => boolean;
  onProcessExpandedChange?: (processKey: string, expanded: boolean) => void;
  t: TFunction<"chat">;
}) {
  const trace = useMemo(() => processSummaryToTrace(message, t), [message, t]);
  const detailSteps = detailMessages.length > 0 && renderDetailMessage ? [] : trace.steps;
  const resolvedProcessKey = processKey || message.id || message.runId || message.activityId;
  const expanded = resolvedProcessKey ? isProcessExpanded?.(resolvedProcessKey, false) : undefined;

  return (
    <ProcessTrace
      label={trace.label}
      collapsedDetail={trace.collapsedDetail}
      statusLabel={trace.statusLabel}
      status={trace.status}
      metrics={trace.metrics}
      steps={detailSteps}
      expanded={expanded}
      onExpandedChange={
        resolvedProcessKey ? nextExpanded => onProcessExpandedChange?.(resolvedProcessKey, nextExpanded) : undefined
      }
    >
      {detailMessages.length > 0 && renderDetailMessage
        ? detailMessages.map((detailMessage, index) => renderDetailMessage(detailMessage, index))
        : null}
    </ProcessTrace>
  );
}

export function ProcessAttachmentRow({
  attachment,
  renderDetail,
  isProcessExpanded,
  onProcessExpandedChange,
  t,
}: {
  attachment: ProcessAttachment;
  renderDetail: (message: ChatMessage, index: number) => ReactNode;
  isProcessExpanded?: (processKey: string, defaultExpanded?: boolean) => boolean;
  onProcessExpandedChange?: (processKey: string, expanded: boolean) => void;
  t: TFunction<"chat">;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxImages: LightboxImage[] = useMemo(
    () =>
      attachment.inlineImages.map(image => ({
        data: image.data,
        name: image.name,
        mimeType: image.mimeType,
      })),
    [attachment.inlineImages],
  );

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <ProcessSummaryRow
        message={attachment.processSummary}
        processKey={attachment.id}
        detailMessages={attachment.processDetailMessages}
        renderDetailMessage={renderDetail}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={onProcessExpandedChange}
        t={t}
      />
      {lightboxImages.length > 0 ? (
        <div className="flex max-w-full flex-wrap gap-2">
          {lightboxImages.map((image, idx) => (
            <button
              type="button"
              key={`${attachment.inlineImages[idx].toolId || "tool-image"}-${idx}`}
              onClick={() => setLightboxIndex(idx)}
              className="block overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xs transition hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-hidden dark:border-neutral-700 dark:bg-neutral-900"
              aria-label={image.name ? `Preview ${image.name}` : "Preview image"}
            >
              <img
                src={image.data}
                alt={image.name || "Tool result image"}
                className="block h-auto max-h-72 max-w-xs cursor-zoom-in object-contain"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}
      {lightboxIndex !== null && lightboxImages.length > 0 ? (
        <ImageLightbox images={lightboxImages} startIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
      ) : null}
    </div>
  );
}
