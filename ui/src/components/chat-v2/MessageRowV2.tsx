import { memo, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DiffLine } from "../chat/utils/messageTransforms";
import type { Project, SessionProvider } from "../../types/app";
import { DOCUMENT_SELECTION_ATTACHMENT_KIND, type DocumentSelectionReference } from "../../types/documentSelection";
import {
  CONTENT_REFERENCE_ATTACHMENT_KIND,
  normalizeContentReference,
  type ContentReference,
} from "../../types/contentReference";
import type {
  ChatAttachment,
  ChatImage,
  ChatMessage,
  SatiPermissionSuggestion,
  SessionPermissionGrantResult,
} from "../chat/types/types";
import MessageComponent from "../chat/view/subcomponents/MessageComponent";
import { formatUsageLimitText } from "../chat/utils/chatFormatting";
import type { ProcessAttachment } from "./processGrouping";
import SubagentCard from "./SubagentCard";
import { useTypewriter } from "./useTypewriter";
import { linkifyFilePathsOutsideCode } from "./linkifyFilePathsOutsideCode";
import { AssistantMessageRow } from "./messageRow/AssistantMessageRow";
import { hasAssistantBody } from "./messageRow/messageRowVisibility";
import { ErrorMessageRow } from "./messageRow/ErrorMessageRow";
import { ProcessAttachmentRow, ProcessSummaryRow } from "./messageRow/MessageProcessRows";
import { ThinkingMessageRow } from "./messageRow/ThinkingMessageRow";
import { UserMessageRow } from "./messageRow/UserMessageRow";

function attachmentToDocumentReference(attachment: ChatAttachment): ContentReference | null {
  const structured = normalizeContentReference(attachment.contentReference);
  if (structured) return structured;
  if (attachment.kind !== DOCUMENT_SELECTION_ATTACHMENT_KIND || !attachment.selectedText) return null;
  const filePath = attachment.filePath || attachment.path || "";
  if (!filePath) return null;
  return normalizeContentReference({
    kind: DOCUMENT_SELECTION_ATTACHMENT_KIND,
    id: `${filePath}-${attachment.createdAt || ""}-${attachment.occurrenceIndex ?? ""}`,
    fileName: attachment.fileName || attachment.name,
    filePath,
    source: attachment.source === "pdf" ? "pdf" : "office-pdf",
    pageNumbers: Array.isArray(attachment.pageNumbers) ? attachment.pageNumbers : [],
    selectedText: attachment.selectedText,
    surroundingText: attachment.surroundingText,
    occurrenceIndex: attachment.occurrenceIndex,
    createdAt: attachment.createdAt || new Date(0).toISOString(),
    truncated: attachment.truncated,
  } satisfies DocumentSelectionReference);
}

type MessageRowV2Props = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  nextMessage?: ChatMessage | null;
  beforeProcessAttachments?: ProcessAttachment[];
  afterProcessAttachments?: ProcessAttachment[];
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (
    suggestion: SatiPermissionSuggestion,
  ) => SessionPermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  isProcessExpanded?: (processKey: string, defaultExpanded?: boolean) => boolean;
  onProcessExpandedChange?: (processKey: string, expanded: boolean) => void;
  onOpenSubagentDetail?: (subagentId: string) => void;
  subagentActivityById?: Map<string, ChatMessage>;
  subagentThinkingById?: Map<string, string>;
  isSessionRunning?: boolean;
  onFork?: (message: ChatMessage, carriedMessageCount: number) => void;
  forkCarriedMessageCount?: number;
  forkDisabled?: boolean;
  showAssistantActions?: boolean;
  // 协议 1.7：最后一条 user 消息可编辑（预填 composer 后改发 edit-last-turn），
  // 最后一条 assistant 消息可重新生成（regenerate-last-turn）。
  onEditLastUserMessage?: (message: ChatMessage) => void;
  onRegenerateLastTurn?: (message: ChatMessage) => void;
  isLastUserMessage?: boolean;
  isLastAssistantMessage?: boolean;
};

// Fall back to the heavy legacy renderer for anything that isn't a vanilla
// user/assistant markdown message — tool invocations, diffs, permission
// prompts, task notifications, subagent containers, etc. live there and we
// don't want to re-implement them all.
const shouldDelegate = (message: ChatMessage): boolean => {
  if (message.isSubagentContainer) return false;
  if (message.isToolUse) return true;
  if (message.isInteractivePrompt) return true;
  if (message.isTaskNotification) return true;
  const t = message.type;
  if (t !== "user" && t !== "assistant" && t !== "error") return true;
  return false;
};

function MessageRowV2({
  message,
  prevMessage,
  beforeProcessAttachments = [],
  afterProcessAttachments = [],
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantSessionToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
  inlineThinking,
  isProcessExpanded,
  onProcessExpandedChange,
  onOpenSubagentDetail,
  subagentActivityById,
  subagentThinkingById,
  isSessionRunning,
  onFork,
  forkCarriedMessageCount = 0,
  forkDisabled = false,
  showAssistantActions,
  onEditLastUserMessage,
  onRegenerateLastTurn,
  isLastUserMessage = false,
  isLastAssistantMessage = false,
}: MessageRowV2Props) {
  const { t } = useTranslation("chat");
  const delegate = useMemo(() => shouldDelegate(message), [message]);

  const formattedContent = useMemo(() => formatUsageLimitText(String(message.content ?? "")), [message.content]);
  const thinkingDisplayText = useTypewriter(formattedContent, !!message.isStreaming && !!message.isThinking, 4);
  const contentDisplayText = useTypewriter(formattedContent, !!message.isStreaming && !message.isThinking, 6);
  const linkedContentDisplayText = useMemo(
    () => (message.isStreaming ? contentDisplayText : linkifyFilePathsOutsideCode(contentDisplayText)),
    [contentDisplayText, message.isStreaming],
  );
  const messageAttachments = useMemo(
    () =>
      Array.isArray(message.attachments)
        ? message.attachments.filter(attachment => attachment && typeof attachment.name === "string")
        : [],
    [message.attachments],
  );
  const documentReferenceAttachments = useMemo(
    () =>
      messageAttachments
        .map(attachmentToDocumentReference)
        .filter((reference): reference is ContentReference => Boolean(reference)),
    [messageAttachments],
  );
  const referenceImageNames = useMemo(
    () =>
      new Set(
        documentReferenceAttachments
          .filter(reference => reference.selectionMode === "region")
          .map(reference => reference.image.name),
      ),
    [documentReferenceAttachments],
  );
  const messageImages: ChatImage[] = useMemo(
    () =>
      Array.isArray(message.images)
        ? message.images.filter(
            image => image && typeof image.data === "string" && !referenceImageNames.has(image.name),
          )
        : [],
    [message.images, referenceImageNames],
  );
  const fileAttachments = useMemo(
    () =>
      messageAttachments.filter(
        attachment =>
          attachment.kind !== DOCUMENT_SELECTION_ATTACHMENT_KIND &&
          attachment.kind !== CONTENT_REFERENCE_ATTACHMENT_KIND,
      ),
    [messageAttachments],
  );
  const hasForkUnsupportedContent =
    Boolean(message.forkUnsupportedContent) || messageImages.length > 0 || messageAttachments.length > 0;

  if (message.isAgentActivitySummary) {
    return (
      <ProcessSummaryRow
        message={message}
        processKey={message.id || message.runId || message.activityId}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={onProcessExpandedChange}
        t={t}
      />
    );
  }

  const renderProcessAttachment = (attachment: ProcessAttachment) => (
    <ProcessAttachmentRow
      key={attachment.id}
      attachment={attachment}
      renderDetail={(detailMessage, index) => (
        <MessageRowV2
          key={detailMessage.id || detailMessage.toolId || `${attachment.id || "process-detail"}-${index}`}
          message={detailMessage}
          prevMessage={index > 0 ? attachment.processDetailMessages[index - 1] : null}
          provider={provider}
          selectedProject={selectedProject}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantSessionToolPermission={onGrantSessionToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          isProcessExpanded={isProcessExpanded}
          onProcessExpandedChange={onProcessExpandedChange}
          onOpenSubagentDetail={onOpenSubagentDetail}
          subagentActivityById={subagentActivityById}
        />
      )}
      isProcessExpanded={isProcessExpanded}
      onProcessExpandedChange={onProcessExpandedChange}
      t={t}
    />
  );

  const withProcessRows = (content: ReactNode) => {
    if (beforeProcessAttachments.length === 0 && afterProcessAttachments.length === 0) {
      return content;
    }

    return (
      <div className="flex min-w-0 flex-col gap-2">
        {beforeProcessAttachments.map(renderProcessAttachment)}
        {content}
        {afterProcessAttachments.map(renderProcessAttachment)}
      </div>
    );
  };

  if (message.isSubagentContainer) {
    const subagentId = typeof message.subagentId === "string" ? message.subagentId : "";
    const liveActivity = subagentId ? subagentActivityById?.get(subagentId) : undefined;
    const thinkingContent = subagentId ? subagentThinkingById?.get(subagentId) : undefined;
    return withProcessRows(
      <SubagentCard
        message={message}
        liveActivity={liveActivity}
        onOpenDetail={onOpenSubagentDetail}
        thinkingContent={thinkingContent}
        isSessionRunning={isSessionRunning}
      />,
    );
  }

  if (delegate) {
    return withProcessRows(
      <div className="ui-v2-legacy-row">
        <MessageComponent
          message={message}
          prevMessage={prevMessage}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantSessionToolPermission={onGrantSessionToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject ?? null}
          provider={provider}
          hideHeader
        />
      </div>,
    );
  }

  // User: right-aligned grey bubble.
  if (message.type === "user") {
    return withProcessRows(
      <UserMessageRow
        message={message}
        formattedContent={formattedContent}
        messageImages={messageImages}
        documentReferenceAttachments={documentReferenceAttachments}
        fileAttachments={fileAttachments}
        selectedProject={selectedProject}
        onFileOpen={onFileOpen}
        onFork={onFork}
        forkCarriedMessageCount={forkCarriedMessageCount}
        forkDisabled={forkDisabled}
        isSessionRunning={isSessionRunning}
        hasForkUnsupportedContent={hasForkUnsupportedContent}
        onEditLastUserMessage={onEditLastUserMessage}
        isLastUserMessage={isLastUserMessage}
        t={t}
      />,
    );
  }

  // Error: full-width red banner with warning glyph.
  if (message.type === "error") {
    return withProcessRows(
      <ErrorMessageRow formattedContent={formattedContent} selectedProject={selectedProject} onFileOpen={onFileOpen} />,
    );
  }

  if (message.isThinking) {
    if (!showThinking) return null;
    return withProcessRows(
      <ThinkingMessageRow
        isStreaming={!!message.isStreaming}
        inlineThinking={inlineThinking}
        thinkingDisplayText={thinkingDisplayText}
        formattedContent={formattedContent}
        selectedProject={selectedProject}
        onFileOpen={onFileOpen}
        t={t}
      />,
    );
  }

  // Assistant: plain prose, no avatar and no bubble.
  if (
    !hasAssistantBody(message, contentDisplayText) &&
    beforeProcessAttachments.length === 0 &&
    afterProcessAttachments.length === 0
  ) {
    return null;
  }

  return withProcessRows(
    <AssistantMessageRow
      message={message}
      linkedContentDisplayText={linkedContentDisplayText}
      contentDisplayText={contentDisplayText}
      formattedContent={formattedContent}
      selectedProject={selectedProject}
      onFileOpen={onFileOpen}
      onFork={onFork}
      forkCarriedMessageCount={forkCarriedMessageCount}
      forkDisabled={forkDisabled}
      isSessionRunning={isSessionRunning}
      showAssistantActions={showAssistantActions}
      onRegenerateLastTurn={onRegenerateLastTurn}
      isLastAssistantMessage={isLastAssistantMessage}
      t={t}
    />,
  );
}

export default memo(MessageRowV2);
