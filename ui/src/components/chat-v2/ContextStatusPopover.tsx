import type { TFunction } from "i18next";
import { cn } from "../../lib/utils.js";
import type { ModelContextRequest } from "../chat-context/ContextInspector";
import { CONTEXT_TONE_BADGE_STYLES, type ContextStatus } from "./contextStatus";

/**
 * 上下文用量气泡：合计 + 固定开销/对话用量拆分（服务端给出固定开销时）。
 *
 * 从 `ComposerV2` 抽出的独立组件——气泡文案自成一体，留在主组件里只会让
 * 已超长的渲染函数继续变长。
 */
export function ContextStatusPopover({
  status,
  title,
  t,
  modelContext,
  onInspectContext,
}: {
  status: ContextStatus;
  title: string;
  t: TFunction;
  modelContext?: ModelContextRequest;
  onInspectContext?: () => void;
}) {
  const usedText = t("input.contextStatusUsed", {
    used: status.used.toLocaleString(),
    total: status.displayTotal.toLocaleString(),
    defaultValue: `${status.used.toLocaleString()} tokens used out of ${status.displayTotal.toLocaleString()}.`,
  }) as string;
  const sliceValue = (tokens: string, percent: number) =>
    t("input.contextStatusSliceValue", {
      tokens,
      percent,
      defaultValue: "{{tokens}} ({{percent}}%)",
    }) as string;
  return (
    <div
      role="status"
      className="absolute right-0 bottom-full z-50 mb-2 w-64 max-w-[100vw] rounded-lg border border-neutral-200 bg-white p-3 text-left text-[12px] leading-5 text-neutral-700 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium text-neutral-900 dark:text-neutral-100">{title}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
            CONTEXT_TONE_BADGE_STYLES[status.tone],
          )}
        >
          {status.known ? status.percentLabel : "--"}
        </span>
      </div>
      {status.known ? (
        <>
          <div className="text-neutral-500 dark:text-neutral-400">{usedText}</div>
          {status.fixedOverhead && status.conversation ? (
            <ul className="mt-2 space-y-1">
              <li className="flex items-center justify-between gap-2 text-neutral-500 dark:text-neutral-400">
                <span>{t("input.contextStatusFixed", { defaultValue: "Prompt & tools (fixed)" })}</span>
                <span className="shrink-0 tabular-nums">
                  {sliceValue(status.fixedOverhead.label, status.fixedOverhead.percent)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2 text-neutral-500 dark:text-neutral-400">
                <span>{t("input.contextStatusConversation", { defaultValue: "Conversation" })}</span>
                <span className="shrink-0 tabular-nums">
                  {sliceValue(status.conversation.label, status.conversation.percent)}
                </span>
              </li>
            </ul>
          ) : null}
          <div className="mt-2 text-neutral-500 dark:text-neutral-400">
            {t("input.contextStatusAutoCompact", {
              defaultValue: "Auto compact runs when the conversation approaches the configured limit.",
            })}
          </div>
          {status.state === "blocking" ? (
            <div className="mt-2 text-red-600 dark:text-red-300">
              {t("input.contextStatusBlockingBody", {
                defaultValue: "Compaction ran, but the context is still over the limit.",
              })}
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-neutral-500 dark:text-neutral-400">
          {t("input.contextStatusUnknownBody", {
            defaultValue: "No token budget has been reported yet. It will appear after the next model response.",
          })}
        </div>
      )}
      {modelContext && onInspectContext ? (
        <button
          type="button"
          onClick={onInspectContext}
          className="mt-2 w-full rounded-md border border-neutral-200 px-2 py-1 text-left text-[12px] font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          {t("contextInspector.open", { defaultValue: "Inspect context" })}
        </button>
      ) : null}
    </div>
  );
}
