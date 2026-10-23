import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { Pencil } from "lucide-react";
import type { Project } from "../../../types/app";
import type { ContentReference } from "../../../types/contentReference";
import type { ChatAttachment, ChatImage, ChatMessage } from "../../chat/types/types";
import ImageLightbox, { type LightboxImage } from "../../chat/view/subcomponents/ImageLightbox";
import { Markdown } from "../../chat/view/subcomponents/Markdown";
import DocumentReferenceChip from "../DocumentReferenceChip";
import { UserAttachmentCards } from "../MessageFileCards";
import { ForkMessageButton, HoverActionButton } from "./MessageRowActions";

export type UserMessageRowProps = {
  message: ChatMessage;
  formattedContent: string;
  messageImages: ChatImage[];
  documentReferenceAttachments: ContentReference[];
  fileAttachments: ChatAttachment[];
  selectedProject: Project | null;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onFork?: (message: ChatMessage, carriedMessageCount: number) => void;
  forkCarriedMessageCount: number;
  forkDisabled: boolean;
  isSessionRunning?: boolean;
  hasForkUnsupportedContent: boolean;
  onEditLastUserMessage?: (message: ChatMessage) => void;
  isLastUserMessage: boolean;
  t: TFunction<"chat">;
};

export function UserMessageRow({
  message,
  formattedContent,
  messageImages,
  documentReferenceAttachments,
  fileAttachments,
  selectedProject,
  onFileOpen,
  onFork,
  forkCarriedMessageCount,
  forkDisabled,
  isSessionRunning,
  hasForkUnsupportedContent,
  onEditLastUserMessage,
  isLastUserMessage,
  t,
}: UserMessageRowProps) {
  const [userImageLightbox, setUserImageLightbox] = useState<number | null>(null);
  const lightboxImages: LightboxImage[] = useMemo(
    () =>
      messageImages.map(image => ({
        data: image.data,
        name: image.name,
        mimeType: image.mimeType,
      })),
    [messageImages],
  );

  return (
    <div className="group/user-msg flex w-full items-end justify-end gap-1.5">
      {onFork ? (
        <ForkMessageButton
          carriedMessageCount={forkCarriedMessageCount}
          disabled={forkDisabled || isSessionRunning || !message.entryId || hasForkUnsupportedContent}
          disabledReason={
            hasForkUnsupportedContent
              ? String(
                  message.forkUnsupportedReason ||
                    t("fork.unsupportedAttachments", {
                      defaultValue: "Forking messages with attachments or media is not supported yet",
                    }),
                )
              : undefined
          }
          onFork={() => {
            if (message.entryId && !hasForkUnsupportedContent) onFork(message, forkCarriedMessageCount);
          }}
          t={t}
        />
      ) : null}
      {onEditLastUserMessage && isLastUserMessage && !hasForkUnsupportedContent ? (
        <HoverActionButton
          icon={<Pencil className="h-3.5 w-3.5" strokeWidth={2} />}
          label={t("input.editLastTurn", { defaultValue: "Edit message" })}
          disabled={Boolean(isSessionRunning || !message.entryId)}
          onClick={() => onEditLastUserMessage(message)}
          variant="user-hover"
        />
      ) : null}
      <div className="max-w-[78%] min-w-0 overflow-hidden rounded-[20px] bg-gradient-to-br from-neutral-100 to-neutral-100/70 px-4 py-2.5 text-[14px] leading-relaxed text-neutral-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:from-neutral-800 dark:to-neutral-800/70 dark:text-neutral-100 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        {message.isStreaming && !formattedContent ? (
          <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
        ) : (
          <>
            {documentReferenceAttachments.length > 0 ? (
              <div
                className={
                  formattedContent || fileAttachments.length > 0 ? "mb-2 flex flex-wrap gap-2" : "flex flex-wrap gap-2"
                }
              >
                {documentReferenceAttachments.map(reference => (
                  <DocumentReferenceChip
                    key={reference.id}
                    reference={reference}
                    summaryLength={100}
                    className="bg-white/80 dark:bg-neutral-900/55"
                    onOpen={onFileOpen ? () => onFileOpen(reference.source.relativePath) : undefined}
                  />
                ))}
              </div>
            ) : null}
            {fileAttachments.length > 0 ? (
              <div className={formattedContent ? "mb-2" : undefined}>
                <UserAttachmentCards attachments={fileAttachments} project={selectedProject} onBrowse={onFileOpen} />
              </div>
            ) : null}
            {messageImages.length > 0 ? (
              <div className={formattedContent ? "mb-2 grid grid-cols-1 gap-2" : "grid grid-cols-1 gap-2"}>
                {messageImages.map((image, index) => (
                  <button
                    type="button"
                    key={`${image.name || "image"}-${index}`}
                    onClick={() => setUserImageLightbox(index)}
                    className="block w-72 max-w-full overflow-hidden rounded-xl border border-neutral-200 bg-white/70 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-hidden dark:border-neutral-700 dark:bg-neutral-900/40"
                    aria-label={image.name ? `Preview ${image.name}` : "Preview image"}
                  >
                    <img
                      src={image.data}
                      alt={image.name || "Uploaded image"}
                      className="block h-auto max-h-64 w-full cursor-zoom-in object-contain transition-opacity hover:opacity-90"
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            ) : null}
            {formattedContent ? (
              <Markdown
                className="prose prose-sm max-w-none min-w-0 [overflow-wrap:anywhere] prose-neutral dark:prose-invert prose-p:my-1 prose-ol:my-1 prose-ul:my-1 prose-li:my-0"
                projectName={selectedProject?.name}
                onFileOpen={onFileOpen}
              >
                {formattedContent}
              </Markdown>
            ) : null}
          </>
        )}
      </div>
      {userImageLightbox !== null && lightboxImages.length > 0 ? (
        <ImageLightbox
          images={lightboxImages}
          startIndex={userImageLightbox}
          onClose={() => setUserImageLightbox(null)}
        />
      ) : null}
    </div>
  );
}
