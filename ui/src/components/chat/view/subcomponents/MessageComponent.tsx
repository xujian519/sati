import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import type { ChatMessage, SatiPermissionSuggestion, Provider, SessionPermissionGrantResult } from "../../types/types";
import { formatUsageLimitText } from "../../utils/chatFormatting";
import type { Project } from "../../../../types/app";
import { ToolRenderer, shouldHideToolResult } from "../../tools";
import { stringifyMessageContent } from "../../utils/messageContent";
import { CompactBoundaryRow } from "./CompactBoundaryRow";
import { Markdown } from "./Markdown";
import MessageCopyControl from "./MessageCopyControl";
import ImageLightbox, { type LightboxImage } from "./ImageLightbox";
import ToolResultBlock from "./ToolResultBlock";
import InteractivePromptBlock from "./InteractivePromptBlock";
type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (
    suggestion: SatiPermissionSuggestion,
  ) => SessionPermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
  hideHeader?: boolean;
};

type I18nDescriptor = {
  key?: unknown;
  params?: unknown;
};

function translateDescriptor(t: ReturnType<typeof useTranslation>["t"], descriptor: unknown, fallback: string): string {
  if (!descriptor || typeof descriptor !== "object") return fallback;
  const { key, params } = descriptor as I18nDescriptor;
  if (typeof key !== "string" || !key.trim()) return fallback;
  const interpolation =
    params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  return t(key, { ...interpolation, defaultValue: fallback });
}

function resolveHeaderTypeLabel(
  t: ReturnType<typeof useTranslation>["t"],
  messageType: string,
  provider: Provider | string,
): string {
  if (messageType === "error") return t("messageTypes.error");
  if (messageType === "tool") return t("messageTypes.tool");
  if (provider === "cursor") return t("messageTypes.cursor");
  if (provider === "codex") return t("messageTypes.codex");
  if (provider === "gemini") return t("messageTypes.gemini");
  return t("messageTypes.sati");
}

const TASK_STATUS_DOT_STYLES: Record<string, string> = {
  completed: "bg-green-500",
  failed: "bg-red-500",
  error: "bg-red-500",
};

const MessageComponent = memo(
  ({
    message,
    prevMessage,
    createDiff,
    onFileOpen,
    onShowSettings,
    onGrantSessionToolPermission,
    autoExpandTools,
    showRawParameters,
    showThinking,
    selectedProject,
    provider,
    hideHeader = false,
  }: MessageComponentProps) => {
    const { t } = useTranslation("chat");
    const isGrouped =
      prevMessage &&
      prevMessage.type === message.type &&
      (prevMessage.type === "assistant" ||
        prevMessage.type === "user" ||
        prevMessage.type === "tool" ||
        prevMessage.type === "error");
    const messageRef = useRef<HTMLDivElement | null>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const [compactShadowedOpen, setCompactShadowedOpen] = useState(false);
    const rawMessageContent = stringifyMessageContent(message.content);
    const messageContent = translateDescriptor(t, message.contentI18n, rawMessageContent);
    const userHintContent = translateDescriptor(t, message.userHintI18n, stringifyMessageContent(message.userHint));
    const toolResultImages: LightboxImage[] = useMemo(() => {
      const list = (message.toolResult?.images ?? []) as Array<{ data?: unknown; name?: unknown; mimeType?: unknown }>;
      return list
        .filter(image => image && typeof image.data === "string" && image.data.length > 0)
        .map(image => ({
          data: image.data as string,
          name: typeof image.name === "string" ? image.name : undefined,
          mimeType: typeof image.mimeType === "string" ? image.mimeType : undefined,
        }));
    }, [message.toolResult]);
    const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
    const openLightbox = (images: LightboxImage[], index: number) => setLightbox({ images, index });
    const closeLightbox = () => setLightbox(null);
    const formattedMessageContent = useMemo(() => formatUsageLimitText(messageContent), [messageContent]);
    const assistantCopyContent = message.isToolUse
      ? stringifyMessageContent(message.displayText || message.content)
      : formattedMessageContent;
    const shouldShowAssistantCopyControl =
      message.type === "assistant" && assistantCopyContent.trim().length > 0 && !message.isToolUse;

    useEffect(() => {
      const node = messageRef.current;
      if (!autoExpandTools || !node || !message.isToolUse) return;

      const observer = new IntersectionObserver(
        entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting && !isExpanded) {
              setIsExpanded(true);
              const details = node.querySelectorAll<HTMLDetailsElement>('details:not([data-auto-expand="false"])');
              details.forEach(detail => {
                detail.open = true;
              });
            }
          });
        },
        { threshold: 0.1 },
      );

      observer.observe(node);

      return () => {
        observer.unobserve(node);
      };
    }, [autoExpandTools, isExpanded, message.isToolUse]);

    const formattedTime = useMemo(() => new Date(message.timestamp).toLocaleTimeString(), [message.timestamp]);
    const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);

    if (shouldHideThinkingMessage) {
      return null;
    }

    return (
      <div
        ref={messageRef}
        data-message-timestamp={message.timestamp || undefined}
        // 委托路径下 type 恒非 "user"（user 消息走 v2 原生气泡，见 #159 N04 note），
        // 故原三元只剩后半支，做等价化简。
        className={`chat-message ${message.type} ${isGrouped ? "grouped" : ""} px-3 sm:px-0`}
      >
        {message.isCompactBoundary ? (
          <CompactBoundaryRow
            message={message}
            formattedTime={formattedTime}
            shadowedOpen={compactShadowedOpen}
            onToggleShadowed={() => setCompactShadowedOpen(open => !open)}
            t={t}
          />
        ) : message.isInterruptedNotice ? (
          <div className="my-1 flex w-full items-center justify-center gap-2 px-3 sm:px-0">
            <span className="h-px flex-1 bg-border/60" />
            <span className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("interrupted.label")}
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">{formattedTime}</span>
            <span className="h-px flex-1 bg-border/60" />
          </div>
        ) : message.isTaskNotification ? (
          <div className="w-full">
            <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    TASK_STATUS_DOT_STYLES[message.taskStatus ?? ""] ?? "bg-amber-500"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="break-words text-foreground">{messageContent}</div>
                  {(message.taskStatus || message.taskId) && (
                    <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                      {message.taskStatus && (
                        <span className="rounded bg-background/80 px-1.5 py-0.5">{message.taskStatus}</span>
                      )}
                      {message.taskId && (
                        <span className="rounded bg-background/80 px-1.5 py-0.5">{message.taskId}</span>
                      )}
                    </div>
                  )}
                </div>
                <span className="flex-shrink-0 text-xs text-muted-foreground">{formattedTime}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full">
            {!hideHeader && !isGrouped && (
              <div className="mb-2 flex items-center space-x-3">
                {message.type === "error" ? (
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
                    !
                  </div>
                ) : message.type === "tool" ? (
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">
                    🔧
                  </div>
                ) : (
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-white">
                    <SessionProviderLogo provider={provider} className="h-full w-full" />
                  </div>
                )}
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  {resolveHeaderTypeLabel(t, message.type, provider)}
                </div>
              </div>
            )}

            <div className="w-full">
              {message.isToolUse ? (
                <>
                  <div className="flex flex-col">
                    <div className="flex flex-col">
                      <Markdown
                        className="prose prose-sm max-w-none dark:prose-invert"
                        projectName={selectedProject?.name}
                        onFileOpen={onFileOpen}
                      >
                        {String(message.displayText || "")}
                      </Markdown>
                    </div>
                  </div>

                  {message.toolInput && (
                    <ToolRenderer
                      toolName={message.toolName || "UnknownTool"}
                      toolInput={message.toolInput}
                      toolResult={message.toolResult}
                      toolId={message.toolId}
                      mode="input"
                      onFileOpen={onFileOpen}
                      createDiff={createDiff}
                      selectedProject={selectedProject}
                      autoExpandTools={autoExpandTools}
                      showRawParameters={showRawParameters}
                      rawToolInput={typeof message.toolInput === "string" ? message.toolInput : undefined}
                    />
                  )}

                  {/* Tool-result inline images (read_file PNGs, rendered PDF pages, …).
                    Rendered outside the legacy `Read` config (which sets `hidden: true`)
                    so the picture appears on the assistant/tool side instead of leaking
                    into a stray user-side bubble. */}
                  {toolResultImages.length > 0 && !message.toolResult?.isError && (
                    <div className="my-1 flex flex-wrap gap-2">
                      {toolResultImages.map((image, idx) => (
                        <button
                          type="button"
                          key={`${image.name || "tool-image"}-${idx}`}
                          onClick={() => openLightbox(toolResultImages, idx)}
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
                  )}

                  {/* Tool Result Section */}
                  {message.toolResult &&
                    !shouldHideToolResult(message.toolName || "UnknownTool", message.toolResult) && (
                      <ToolResultBlock
                        message={message}
                        provider={provider}
                        selectedProject={selectedProject}
                        onFileOpen={onFileOpen}
                        onShowSettings={onShowSettings}
                        onGrantSessionToolPermission={onGrantSessionToolPermission}
                        createDiff={createDiff}
                        autoExpandTools={autoExpandTools}
                      />
                    )}
                </>
              ) : message.isInteractivePrompt ? (
                // Special handling for interactive prompts
                <InteractivePromptBlock messageContent={messageContent} />
              ) : (
                <div className="text-sm text-gray-700 dark:text-gray-300">
                  {/* Thinking accordion for reasoning */}
                  {showThinking && message.reasoning && (
                    <details className="mb-3">
                      <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
                        {t("thinking.emoji")}
                      </summary>
                      <div className="mt-2 border-l-2 border-gray-300 pl-4 text-sm text-gray-600 italic dark:border-gray-600 dark:text-gray-400">
                        <div className="whitespace-pre-wrap">{stringifyMessageContent(message.reasoning)}</div>
                      </div>
                    </details>
                  )}

                  {(() => {
                    const content = formattedMessageContent;

                    // Detect if content is pure JSON (starts with { or [)
                    const trimmedContent = content.trim();
                    if (
                      (trimmedContent.startsWith("{") || trimmedContent.startsWith("[")) &&
                      (trimmedContent.endsWith("}") || trimmedContent.endsWith("]"))
                    ) {
                      try {
                        const parsed = JSON.parse(trimmedContent);
                        const formatted = JSON.stringify(parsed, null, 2);

                        return (
                          <div className="my-2">
                            <div className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                                />
                              </svg>
                              <span className="font-medium">{t("json.response")}</span>
                            </div>
                            <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-800 dark:border-gray-700 dark:bg-gray-900">
                              <pre className="overflow-x-auto p-4">
                                <code className="block font-mono text-sm whitespace-pre text-gray-100 dark:text-gray-200">
                                  {formatted}
                                </code>
                              </pre>
                            </div>
                          </div>
                        );
                      } catch {
                        // Not valid JSON, fall through to normal rendering
                      }
                    }

                    // Normal rendering for non-JSON content
                    return message.type === "assistant" ? (
                      <Markdown
                        className="prose prose-sm max-w-none prose-gray dark:prose-invert"
                        projectName={selectedProject?.name}
                        onFileOpen={onFileOpen}
                      >
                        {content}
                      </Markdown>
                    ) : (
                      <div className="whitespace-pre-wrap">{content}</div>
                    );
                  })()}

                  {message.type === "error" && userHintContent && (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800/50 dark:bg-amber-950/30">
                      <svg
                        className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                        />
                      </svg>
                      <span className="text-xs text-amber-700 dark:text-amber-300">{userHintContent}</span>
                    </div>
                  )}
                </div>
              )}

              {(shouldShowAssistantCopyControl || !isGrouped) && (
                <div className="mt-1 flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                  {shouldShowAssistantCopyControl && (
                    <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
                  )}
                  {!isGrouped && <span>{formattedTime}</span>}
                </div>
              )}
            </div>
          </div>
        )}
        {lightbox ? (
          <ImageLightbox images={lightbox.images} startIndex={lightbox.index} onClose={closeLightbox} />
        ) : null}
      </div>
    );
  },
);

export default MessageComponent;
