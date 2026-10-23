import type { TFunction } from "i18next";
import { ChevronRight, Loader2 } from "lucide-react";
import type { Project } from "../../../types/app";
import { Markdown } from "../../chat/view/subcomponents/Markdown";

export type ThinkingMessageRowProps = {
  isStreaming: boolean;
  inlineThinking?: boolean;
  thinkingDisplayText: string;
  formattedContent: string;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  t: TFunction<"chat">;
};

export function ThinkingMessageRow({
  isStreaming,
  inlineThinking,
  thinkingDisplayText,
  formattedContent,
  selectedProject,
  onFileOpen,
  t,
}: ThinkingMessageRowProps) {
  const isThinkingStreaming = isStreaming;

  if (inlineThinking) {
    // Inline mode: unified <details> with typewriter animation + blue theme
    return (
      <div className="min-w-0 text-[14px] leading-relaxed">
        <details className="group" open={(isThinkingStreaming ? thinkingDisplayText.length > 12 : false) || undefined}>
          <summary className="flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-brand-600/70 select-none hover:text-brand-700 dark:text-brand-400/70 dark:hover:text-brand-300">
            {isThinkingStreaming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" strokeWidth={2} />
            )}
            <span>
              {isThinkingStreaming
                ? t("thinking.title", { defaultValue: "Thinking..." })
                : t("thinking.completed", { defaultValue: "Thought process" })}
            </span>
          </summary>
          <div
            className={`mt-1.5 max-h-64 overflow-y-auto border-l-2 pl-3 text-[13px] ${
              isThinkingStreaming
                ? "border-brand-400/50 text-neutral-600 dark:border-brand-500/40 dark:text-neutral-300"
                : "border-brand-400/30 text-neutral-600 dark:border-brand-500/30 dark:text-neutral-400"
            }`}
          >
            <Markdown projectName={selectedProject?.name} onFileOpen={onFileOpen} isStreaming={isThinkingStreaming}>
              {isThinkingStreaming ? thinkingDisplayText : formattedContent}
            </Markdown>
          </div>
        </details>
      </div>
    );
  }

  // Default (status-bar preview mode): simple collapsible accordion
  return (
    <div className="min-w-0 text-[14px] leading-relaxed">
      <details className="group">
        <summary className="flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-neutral-500 select-none hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" strokeWidth={2} />
          <span>{t("thinking.completed", { defaultValue: "Thought process" })}</span>
        </summary>
        <div className="mt-1.5 max-h-64 overflow-y-auto border-l-2 border-neutral-300 pl-3 text-[13px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          <Markdown projectName={selectedProject?.name} onFileOpen={onFileOpen}>
            {formattedContent}
          </Markdown>
        </div>
      </details>
    </div>
  );
}
