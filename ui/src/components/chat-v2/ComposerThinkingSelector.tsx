import type { TFunction } from "i18next";
import { Brain, Check, ChevronDown, type LucideIcon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { thinkingModes, type ThinkingModeId, type ThinkingModeOption } from "../chat/constants/thinkingModes";
import type { ThinkingModeAvailability } from "../chat/constants/thinkingModeAvailability";
import { cn } from "../../lib/utils.js";

type ComposerThinkingSelectorProps = {
  isThinkingModeMenuOpen: boolean;
  setIsThinkingModeMenuOpen: Dispatch<SetStateAction<boolean>>;
  effectiveThinkingMode: ThinkingModeId;
  selectedThinkingMode: ThinkingModeOption;
  SelectedThinkingIcon: LucideIcon;
  thinkingMode: ThinkingModeId;
  thinkingModeAvailability: ThinkingModeAvailability;
  onThinkingModeChange: (mode: ThinkingModeId) => void;
  t: TFunction<"chat">;
};

export default function ComposerThinkingSelector({
  isThinkingModeMenuOpen,
  setIsThinkingModeMenuOpen,
  effectiveThinkingMode,
  selectedThinkingMode,
  SelectedThinkingIcon,
  thinkingMode,
  thinkingModeAvailability,
  onThinkingModeChange,
  t,
}: ComposerThinkingSelectorProps) {
  return (
    <div
      className="relative"
      onBlur={event => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          setIsThinkingModeMenuOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setIsThinkingModeMenuOpen(open => !open)}
        className={cn(
          "pd-composer-icon-button inline-flex h-7 max-w-[116px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[140px]",
          effectiveThinkingMode === "default"
            ? "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            : "text-purple-600 hover:bg-purple-50 dark:text-purple-300 dark:hover:bg-purple-950/30",
        )}
        title={t("input.thinking.change", { defaultValue: "Select thinking strength" }) as string}
        aria-haspopup="menu"
        aria-expanded={isThinkingModeMenuOpen}
      >
        <SelectedThinkingIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <span className="pd-composer-thinking-label truncate">{selectedThinkingMode.name}</span>
        <ChevronDown
          className={cn(
            "pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform",
            isThinkingModeMenuOpen && "rotate-180",
          )}
          strokeWidth={2}
        />
      </button>
      {isThinkingModeMenuOpen ? (
        <div
          role="menu"
          className="absolute right-0 bottom-full z-50 mb-2 w-64 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {thinkingModes.map(option => {
            const Icon = option.icon || Brain;
            const isSelected = option.id === thinkingMode;
            const unavailableReason = thinkingModeAvailability[option.id];
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                disabled={Boolean(unavailableReason)}
                onClick={() => {
                  if (unavailableReason) return;
                  onThinkingModeChange(option.id);
                  setIsThinkingModeMenuOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition",
                  isSelected
                    ? "bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-neutral-50"
                    : "text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800/70",
                  unavailableReason && "cursor-not-allowed opacity-45 hover:bg-transparent dark:hover:bg-transparent",
                )}
                title={option.name}
              >
                <Icon className={cn("h-4 w-4 shrink-0", option.color)} strokeWidth={1.9} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{option.name}</span>
                </span>
                {isSelected ? (
                  <Check className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" strokeWidth={2} />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
