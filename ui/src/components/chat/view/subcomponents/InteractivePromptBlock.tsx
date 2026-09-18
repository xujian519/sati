import { useTranslation } from "react-i18next";

/**
 * 交互提示消息（`isInteractivePrompt`）：问题行 + 选项列表（含选中态）+ 等待说明。
 *
 * 搬移自 `MessageComponent` 的内联 JSX（#159 N04 剩余半边），**未改一个 token**。
 */

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

type InteractivePromptBlockProps = {
  messageContent: string;
};

export default function InteractivePromptBlock({ messageContent }: InteractivePromptBlockProps) {
  const { t } = useTranslation("chat");

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500">
          <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="mb-3 text-base font-semibold text-amber-900 dark:text-amber-100">{t("interactive.title")}</h4>
          {(() => {
            const lines = messageContent.split("\n").filter(line => line.trim());
            const questionLine = lines.find(line => line.includes("?")) || lines[0] || "";
            const options: InteractiveOption[] = [];

            // Parse the menu options
            lines.forEach(line => {
              // Match lines like "❯ 1. Yes" or "  2. No"
              const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
              if (optionMatch) {
                const isSelected = line.includes("❯");
                options.push({
                  number: optionMatch[1],
                  text: optionMatch[2].trim(),
                  isSelected,
                });
              }
            });

            return (
              <>
                <p className="mb-4 text-sm text-amber-800 dark:text-amber-200">{questionLine}</p>

                {/* Option buttons */}
                <div className="mb-4 space-y-2">
                  {options.map(option => (
                    <button
                      key={option.number}
                      className={`w-full rounded-lg border-2 px-4 py-3 text-left transition-all ${
                        option.isSelected
                          ? "border-amber-600 bg-amber-600 text-white shadow-md dark:border-amber-700 dark:bg-amber-700"
                          : "border-amber-300 bg-white text-amber-900 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-100"
                      } cursor-not-allowed opacity-75`}
                      disabled
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                            option.isSelected ? "bg-white/20" : "bg-amber-100 dark:bg-amber-800/50"
                          }`}
                        >
                          {option.number}
                        </span>
                        <span className="flex-1 text-sm font-medium sm:text-base">{option.text}</span>
                        {option.isSelected && <span className="text-lg">❯</span>}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="rounded-lg bg-amber-100 p-3 dark:bg-amber-800/30">
                  <p className="mb-1 text-sm font-medium text-amber-900 dark:text-amber-100">
                    {t("interactive.waiting")}
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-200">{t("interactive.instruction")}</p>
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
