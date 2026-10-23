import type { TFunction } from "i18next";
import { RotateCcw } from "lucide-react";
import type { Project } from "../../../types/app";
import type { ChatFileArtifact, ChatMessage } from "../../chat/types/types";
import { Markdown } from "../../chat/view/subcomponents/Markdown";
import { AgentFileArtifactGroup } from "../MessageFileCards";
import { CopyMarkdownButton, ForkMessageButton, HoverActionButton } from "./MessageRowActions";

export type AssistantMessageRowProps = {
  message: ChatMessage;
  /** 由父级用 hasAssistantBody 单点判定，子组件只负责渲染。 */
  hasBody: boolean;
  linkedContentDisplayText: string;
  contentDisplayText: string;
  formattedContent: string;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onFork?: (message: ChatMessage, carriedMessageCount: number) => void;
  forkCarriedMessageCount: number;
  forkDisabled: boolean;
  isSessionRunning?: boolean;
  showAssistantActions?: boolean;
  onRegenerateLastTurn?: (message: ChatMessage) => void;
  isLastAssistantMessage: boolean;
  t: TFunction<"chat">;
};

export function AssistantMessageRow({
  message,
  hasBody,
  linkedContentDisplayText,
  contentDisplayText,
  formattedContent,
  selectedProject,
  onFileOpen,
  onFork,
  forkCarriedMessageCount,
  forkDisabled,
  isSessionRunning,
  showAssistantActions,
  onRegenerateLastTurn,
  isLastAssistantMessage,
  t,
}: AssistantMessageRowProps) {
  const hasAssistantProse = linkedContentDisplayText.trim().length > 0;
  const assistantArtifacts: ChatFileArtifact[] = Array.isArray(message.artifacts) ? message.artifacts : [];
  const showStreamingCursor = Boolean(message.isStreaming && !contentDisplayText);
  const resolvedShowAssistantActions = showAssistantActions ?? true;
  const showAssistantCopyButton = resolvedShowAssistantActions && hasAssistantProse;
  const canRenderAssistantForkButton = Boolean(resolvedShowAssistantActions && onFork && hasAssistantProse);
  const canRenderAssistantRegenerateButton = Boolean(
    resolvedShowAssistantActions && onRegenerateLastTurn && isLastAssistantMessage && hasAssistantProse,
  );
  const shouldRenderAssistantActions =
    showAssistantCopyButton || canRenderAssistantForkButton || canRenderAssistantRegenerateButton;
  const assistantForkDisabled = Boolean(forkDisabled || isSessionRunning || message.isStreaming || !message.entryId);

  if (!hasBody) return null;

  return (
    <div className="min-w-0 text-[14px] leading-relaxed text-neutral-900 dark:text-neutral-100">
      {showStreamingCursor ? (
        <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
      ) : (
        <Markdown
          className="prose prose-sm max-w-none prose-neutral dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-h2:text-lg prose-h3:text-base prose-p:my-2 prose-pre:my-3 prose-ol:my-2 prose-ul:my-2 prose-table:my-0 prose-hr:my-4"
          projectName={selectedProject?.name}
          onFileOpen={onFileOpen}
          isStreaming={message.isStreaming}
        >
          {linkedContentDisplayText}
        </Markdown>
      )}
      {assistantArtifacts.length > 0 ? (
        <AgentFileArtifactGroup artifacts={assistantArtifacts} project={selectedProject} onBrowse={onFileOpen} />
      ) : null}
      {shouldRenderAssistantActions ? (
        <div className="mt-1.5 flex justify-end gap-1">
          {canRenderAssistantRegenerateButton ? (
            <HoverActionButton
              icon={<RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />}
              label={t("input.regenerateLastTurn", { defaultValue: "Regenerate" })}
              disabled={Boolean(isSessionRunning || message.isStreaming || !message.entryId)}
              onClick={() => onRegenerateLastTurn?.(message)}
              variant="action-row"
            />
          ) : null}
          {canRenderAssistantForkButton ? (
            <ForkMessageButton
              carriedMessageCount={forkCarriedMessageCount}
              disabled={assistantForkDisabled}
              onFork={() => {
                if (!assistantForkDisabled && message.entryId) onFork?.(message, forkCarriedMessageCount);
              }}
              t={t}
              variant="action-row"
            />
          ) : null}
          {showAssistantCopyButton ? <CopyMarkdownButton content={formattedContent} /> : null}
        </div>
      ) : null}
    </div>
  );
}
