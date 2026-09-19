import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, Settings } from "lucide-react";
import type { DiffCalculator } from "../../utils/messageTransforms";
import type { ChatMessage, Provider, SatiPermissionSuggestion, SessionPermissionGrantResult } from "../../types/types";
import type { Project } from "../../../../types/app";
import { getSatiPermissionSuggestion } from "../../utils/chatPermissions";
import { stringifyMessageContent } from "../../utils/messageContent";
import { ToolRenderer } from "../../tools";
import { CollapsibleDisplay } from "../../tools/components";
import { Markdown } from "./Markdown";

// 工具结果块：从 `MessageComponent` 拆出的 ~270 行内联 JSX + 它专用的权限授予状态（#159 N04）。

// 下面三个判定原先与错误态 JSX 同居 `MessageComponent.tsx`，随本块一并搬出（未改一个 token）。
function cleanToolUseErrorContent(content: unknown): string {
  return stringifyMessageContent(content)
    .replace(/<\/?tool_use_error>/g, "")
    .replace(/^InputValidationError:\s*/i, "")
    .trim();
}

function isRecoverableToolUseError(content: unknown): boolean {
  const text = stringifyMessageContent(content);
  if (!text.includes("<tool_use_error>")) return false;

  const lower = text.toLowerCase();
  const looksLikePermissionError =
    lower.includes("permission") &&
    (lower.includes("denied") ||
      lower.includes("not allowed") ||
      lower.includes("requires") ||
      lower.includes("grant"));

  return !looksLikePermissionError;
}

function isWebSearchError(toolName: string | undefined): boolean {
  const name = (toolName ?? "").toLowerCase();
  return name === "web_search" || name === "websearch";
}

type PermissionGrantState = "idle" | "granted" | "error";

type ToolResultBlockProps = {
  message: ChatMessage;
  provider: Provider | string;
  /** 与父组件一致：允许缺省（`MessageComponent` 的该 prop 是可选的）。 */
  selectedProject?: Project | null;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (
    suggestion: SatiPermissionSuggestion,
  ) => SessionPermissionGrantResult | null | undefined;
  /**
   * 与 `chat/utils/messageTransforms.ts` 的 `DiffCalculator` 同型。TD-UI-CHAT-N15 已收敛：
   * 全仓 7 份本地 `DiffLine` 副本统一到权威窄类型（`type: "added" | "removed"`），唯一消费
   * `.type` 的点是 `ToolDiffViewer`，而 `calculateDiff` 的三个产出点全是字面量。
   */
  createDiff: DiffCalculator;
  autoExpandTools?: boolean;
};

/**
 * 工具结果块：错误态（`setup_required` / 网页搜索未配置 / 权限授予 / 普通错误）与非错误态
 * （后者交给 `ToolRenderer`，保持单一真源）。
 *
 * 搬移自 `MessageComponent` 的内联 JSX，**未改一个 token**；唯一新增的是下面那句
 * `if (!message.toolResult) return null;`——它只用于让类型收窄，父组件的
 * `message.toolResult &&` 守卫仍在（沿用原有的渲染条件）。
 */
export default function ToolResultBlock({
  message,
  provider,
  selectedProject,
  onFileOpen,
  onShowSettings,
  onGrantSessionToolPermission,
  createDiff,
  autoExpandTools,
}: ToolResultBlockProps) {
  const { t } = useTranslation("chat");
  const permissionSuggestion = getSatiPermissionSuggestion(message, provider);
  const [permissionGrantState, setPermissionGrantState] = useState<PermissionGrantState>("idle");

  useEffect(() => {
    setPermissionGrantState("idle");
  }, [permissionSuggestion?.entry, message.toolId]);

  // 父组件已保证只有存在工具结果时才渲染本块；这里再收一次，让下面的 `message.toolResult`
  // 在类型上非空（与原先内联时靠外层 `message.toolResult &&` 收窄等价）。
  if (!message.toolResult) return null;

  return message.toolResult.isError ? (
    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
      {(() => {
        if (isWebSearchError(message.toolName) && message.toolResult?.errorCode === "setup_required") {
          return (
            <div className="my-1.5 overflow-hidden rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-800/50 dark:bg-amber-950/20">
              <div className="flex items-start gap-3 px-4 py-3">
                <Search className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {t("toolUseError.webSearchNotConfigured.title", {
                      defaultValue: "Web Search Not Ready",
                    })}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-amber-700/90 dark:text-amber-300/80">
                    {t("toolUseError.webSearchNotConfigured.description", {
                      defaultValue:
                        "The search API key is missing or invalid. Please go to Settings -> Config -> Search to check your search provider and API key.",
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== "undefined" && window.openSettings) {
                        window.openSettings("config:tools");
                      } else if (onShowSettings) {
                        onShowSettings();
                      }
                    }}
                    className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white/80 px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-white dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
                  >
                    <Settings className="h-3 w-3" />
                    {t("toolUseError.webSearchNotConfigured.openSettings", {
                      defaultValue: "Go to Settings",
                    })}
                  </button>
                </div>
              </div>
            </div>
          );
        }

        const recoverableToolError = isRecoverableToolUseError(message.toolResult?.content);
        const renderedErrorContent = recoverableToolError
          ? cleanToolUseErrorContent(message.toolResult?.content)
          : stringifyMessageContent(message.toolResult?.content);

        if (message.toolResult?.errorCode === "setup_required") {
          return (
            <div className="my-1 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/50 dark:bg-amber-950/30">
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
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  {t("setupRequired.title", { defaultValue: "Configuration needed" })}
                </div>
                <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-300/80">{renderedErrorContent}</div>
                {onShowSettings && (
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== "undefined" && window.openSettings) {
                        window.openSettings("config");
                      } else {
                        onShowSettings();
                      }
                    }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white/80 px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-white dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    {t("setupRequired.openSettings", { defaultValue: "Open Settings" })}
                  </button>
                )}
              </div>
            </div>
          );
        }

        if (!permissionSuggestion) {
          return (
            <CollapsibleDisplay
              toolName={message.toolName || "UnknownTool"}
              toolId={message.toolId}
              title={t("toolUseError.title", { defaultValue: "Tool error" })}
              defaultOpen={false}
              toolCategory="default"
              autoExpandable={false}
            >
              <Markdown
                className="prose prose-sm max-w-none dark:prose-invert"
                projectName={selectedProject?.name}
                onFileOpen={onFileOpen}
              >
                {renderedErrorContent}
              </Markdown>
            </CollapsibleDisplay>
          );
        }

        return (
          <div className="my-1 border-l-2 border-l-red-500 py-0.5 pl-3 dark:border-l-red-400">
            <details className="group/details relative">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-red-600 transition-colors hover:text-red-700 dark:text-red-300 dark:hover:text-red-200 [&::-webkit-details-marker]:hidden">
                <svg
                  className="h-3.5 w-3.5 transition-transform group-open/details:rotate-90"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span>
                  {recoverableToolError
                    ? t("toolUseError.title", { defaultValue: "Tool error" })
                    : t("messageTypes.error", { defaultValue: "Error" })}
                </span>
                {message.toolName ? (
                  <>
                    <span className="text-red-400/80 dark:text-red-300/60">/</span>
                    <span className="font-normal text-red-500 dark:text-red-300/90">{message.toolName}</span>
                  </>
                ) : null}
              </summary>
              <div className="mt-1.5 pl-[18px] text-xs leading-5 text-gray-700 dark:text-gray-300">
                <Markdown
                  className="prose prose-sm max-w-none prose-red dark:prose-invert"
                  projectName={selectedProject?.name}
                  onFileOpen={onFileOpen}
                >
                  {renderedErrorContent}
                </Markdown>
                <div className="mt-3 border-t border-red-200/60 pt-3 dark:border-red-800/60">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (!onGrantSessionToolPermission) return;
                        const result = onGrantSessionToolPermission(permissionSuggestion);
                        if (result?.pending && result.completion) {
                          setPermissionGrantState("idle");
                          result.completion
                            .then(completion => {
                              setPermissionGrantState(completion.success ? "granted" : "error");
                            })
                            .catch(() => {
                              setPermissionGrantState("error");
                            });
                        } else if (result?.success) {
                          setPermissionGrantState("granted");
                        } else {
                          setPermissionGrantState("error");
                        }
                      }}
                      disabled={permissionSuggestion.isAllowed || permissionGrantState === "granted"}
                      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        permissionSuggestion.isAllowed || permissionGrantState === "granted"
                          ? "cursor-default border-green-300/70 bg-green-100 text-green-800 dark:border-green-800/60 dark:bg-green-900/30 dark:text-green-200"
                          : "border-red-300/70 bg-white/80 text-red-700 hover:bg-white dark:border-red-800/60 dark:bg-gray-900/40 dark:text-red-200 dark:hover:bg-gray-900/70"
                      }`}
                    >
                      {permissionSuggestion.isAllowed || permissionGrantState === "granted"
                        ? t("permissions.added")
                        : t("permissions.grant", { tool: permissionSuggestion.toolName })}
                    </button>
                    {onShowSettings && (
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          // Prefer the global helper when present so we
                          // can land directly on the Permissions tab.
                          // Falls back to the prop (which always
                          // opens at 'appearance') if the shell isn't
                          // mounted with `window.openSettings`.
                          if (typeof window !== "undefined" && window.openSettings) {
                            window.openSettings("permissions");
                          } else {
                            onShowSettings();
                          }
                        }}
                        className="text-xs text-red-700 underline hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
                      >
                        {t("permissions.openSettings")}
                      </button>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-red-700/90 dark:text-red-200/80">
                    {t("permissions.addTo", { entry: permissionSuggestion.entry })}
                  </div>
                  {permissionGrantState === "error" && (
                    <div className="mt-2 text-xs text-red-700 dark:text-red-200">{t("permissions.error")}</div>
                  )}
                  {(permissionSuggestion.isAllowed || permissionGrantState === "granted") && (
                    <div className="mt-2 text-xs text-green-700 dark:text-green-200">{t("permissions.retry")}</div>
                  )}
                </div>
              </div>
            </details>
          </div>
        );
      })()}
    </div>
  ) : (
    // Non-error results - route through ToolRenderer (single source of truth)
    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
      <ToolRenderer
        toolName={message.toolName || "UnknownTool"}
        toolInput={message.toolInput}
        toolResult={message.toolResult}
        toolId={message.toolId}
        mode="result"
        onFileOpen={onFileOpen}
        createDiff={createDiff}
        selectedProject={selectedProject}
        autoExpandTools={autoExpandTools}
      />
    </div>
  );
}
