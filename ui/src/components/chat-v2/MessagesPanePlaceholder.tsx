import { useTranslation } from "react-i18next";
import { GitBranch, XCircle } from "lucide-react";
import type { Project, ProjectSession } from "../../types/app";

/**
 * 会话区的"空 / 加载 / 错误"状态链——消息列表之外的四种占位视图，外加分支会话的专用空态。
 *
 * 从 `MessagesPaneV2.tsx` 搬出（#159 N03b），**被搬 JSX 逐字未改**；分支条件另抽为纯函数
 * `resolveMessagesPanePlaceholder`（原先内联在 JSX 的三元链里，无法直测）。
 *
 * 为什么拆这一块而不是台账原话里的 LiveProcess/Subagent/Fork：那三类**已经是模块级子组件**
 * （`ProcessLiveStatus` / `LiveProcessHeader` / `CompletedProcessHeader` / `SubagentDetailModal`），
 * 留在 pane 里的只剩把它们转发出去的外壳，拆出来只会得到 20–30 个 prop 的纯搬运层；
 * 而这一块是货真价实的渲染分支，且 props 面小、条件可测。
 */

export type MessagesPanePlaceholderKind =
  | "session-load-error"
  | "loading"
  | "new-conversation"
  | "fork-empty"
  | "empty-session";

/** 判定当前该显示哪种占位；返回 null 表示应当渲染消息列表。 */
// eslint-disable-next-line react-refresh/only-export-components -- 见文件头说明：本模块同时导出组件与纯判定
export function resolveMessagesPanePlaceholder({
  hasSessionLoadError,
  isLoadingSessionMessages,
  messageCount,
  isNewConversationEmpty,
  isExistingConversationEmpty,
  isForkedSession,
}: {
  hasSessionLoadError: boolean;
  isLoadingSessionMessages: boolean;
  messageCount: number;
  isNewConversationEmpty: boolean;
  isExistingConversationEmpty: boolean;
  isForkedSession: boolean;
}): MessagesPanePlaceholderKind | null {
  if (hasSessionLoadError) return "session-load-error";
  if (isLoadingSessionMessages && messageCount === 0) return "loading";
  if (isNewConversationEmpty) return "new-conversation";
  if (isExistingConversationEmpty && isForkedSession) return "fork-empty";
  if (isExistingConversationEmpty) return "empty-session";
  return null;
}

type MessagesPanePlaceholderProps = {
  kind: MessagesPanePlaceholderKind;
  sessionLoadError?: string | null;
  onRetrySessionLoad?: (() => void) | null;
  selectedProject?: Project | null;
  suggestedPrompts: string[];
  /** 与被搬 JSX 里的调用名保持一致（原文是 `setInput(prompt)`）。 */
  setInput: (value: string) => void;
  selectedSession?: ProjectSession | null;
  forkParentSessionTitle?: string | null;
  sessionIsReadOnly: boolean;
};

export function MessagesPanePlaceholder({
  kind,
  sessionLoadError,
  onRetrySessionLoad,
  selectedProject,
  suggestedPrompts,
  setInput,
  selectedSession,
  forkParentSessionTitle,
  sessionIsReadOnly,
}: MessagesPanePlaceholderProps) {
  const { t } = useTranslation("chat");

  if (kind === "session-load-error") {
    return (
      <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <XCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
        <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
          {t("session.loadFailedTitle", { defaultValue: "Could not load this conversation" })}
        </div>
        <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
          {sessionLoadError}
        </div>
        {onRetrySessionLoad ? (
          <button
            type="button"
            onClick={onRetrySessionLoad}
            className="inline-flex h-8 items-center rounded-md border border-neutral-200 px-3 text-[13px] font-medium text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            {t("session.retryLoad", { defaultValue: "Retry" })}
          </button>
        ) : null}
      </div>
    );
  }

  if (kind === "loading") {
    return (
      <div className="mx-auto flex h-full max-w-[720px] items-center justify-center px-6 py-10 text-[13px] text-neutral-500 dark:text-neutral-400">
        <div className="flex items-center gap-2">
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-neutral-400" />
          <span>{t("loading", { defaultValue: "Loading..." })}</span>
        </div>
      </div>
    );
  }

  if (kind === "new-conversation") {
    return (
      <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
        <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
          {selectedProject
            ? t("emptyChat.title", { defaultValue: "Start a new conversation" })
            : t("emptyChat.noProject", { defaultValue: "Pick a project from the sidebar" })}
        </div>
        {selectedProject ? (
          <div className="flex flex-col gap-1.5">
            {suggestedPrompts.map(prompt => (
              <button
                key={prompt}
                type="button"
                onClick={() => setInput(prompt)}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-left text-[13px] text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (kind === "fork-empty") {
    return (
      <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
          <GitBranch className="h-5 w-5 text-neutral-500 dark:text-neutral-400" strokeWidth={2} />
        </div>
        <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
          {t("fork.emptyTitle", { defaultValue: "New branch ready" })}
        </div>
        <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
          {t("fork.emptyDescription", {
            parent: forkParentSessionTitle || selectedSession?.parentSessionId || "",
            defaultValue:
              "This branch starts from the beginning of the original conversation. The forked prompt is waiting in the composer — edit it and send to continue here.",
          })}
        </div>
      </div>
    );
  }

  if (kind === "empty-session") {
    return (
      <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
          {sessionIsReadOnly
            ? t("emptyChat.readonlyTranscriptTitle", {
                defaultValue: "No displayable messages in this read-only transcript",
              })
            : t("emptyChat.emptySessionTitle", {
                defaultValue: "No displayable messages in this conversation",
              })}
        </div>
        <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
          {sessionIsReadOnly
            ? t("emptyChat.readonlyTranscriptDescription", {
                defaultValue: "This read-only transcript only contains records the chat view cannot display.",
              })
            : t("emptyChat.emptySessionDescription", {
                defaultValue: "This conversation exists, but it does not contain messages that can be rendered here.",
              })}
        </div>
      </div>
    );
  }

  return null;
}
