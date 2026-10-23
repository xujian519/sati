import type { TFunction } from "i18next";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatRunMode } from "../chat/types/types";
import { cn } from "../../lib/utils.js";
import { RUN_MODE_OPTIONS } from "./composerOptions";

type ComposerRunModeSelectorProps = {
  isRunModeMenuOpen: boolean;
  setIsRunModeMenuOpen: Dispatch<SetStateAction<boolean>>;
  runMode: ChatRunMode;
  onRunModeChange: (mode: ChatRunMode) => void;
  planModeAvailable: boolean;
  selectedRunModeLabel: string;
  SelectedRunModeIcon: LucideIcon;
  t: TFunction<"chat">;
};

export default function ComposerRunModeSelector({
  isRunModeMenuOpen,
  setIsRunModeMenuOpen,
  runMode,
  onRunModeChange,
  planModeAvailable,
  selectedRunModeLabel,
  SelectedRunModeIcon,
  t,
}: ComposerRunModeSelectorProps) {
  return (
    <div
      className="relative mr-1"
      onBlur={event => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          setIsRunModeMenuOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setIsRunModeMenuOpen(open => !open)}
        className={cn(
          "pd-composer-icon-button inline-flex h-7 max-w-[108px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[140px]",
          "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
        )}
        title={
          t("input.runModes.change", {
            defaultValue: "Select run mode",
          }) as string
        }
        aria-haspopup="menu"
        aria-expanded={isRunModeMenuOpen}
      >
        <SelectedRunModeIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <span className="pd-composer-run-label truncate">{selectedRunModeLabel}</span>
        <ChevronDown
          className={cn(
            "pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform",
            isRunModeMenuOpen && "rotate-180",
          )}
          strokeWidth={2}
        />
      </button>
      {isRunModeMenuOpen ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {RUN_MODE_OPTIONS.map(option => {
            const Icon = option.Icon;
            const isSelected = runMode === option.mode;
            const isPlan = option.mode === "plan";
            const isAsk = option.mode === "ask";
            const optionDisabled = isPlan && !planModeAvailable;
            const label = t(option.labelKey, {
              defaultValue: option.defaultLabel,
            }) as string;
            const description = isPlan
              ? (t("input.runModes.planDescription", {
                  defaultValue: "Generate a plan first, then execute after confirmation",
                }) as string)
              : isAsk
                ? (t("input.runModes.askDescription", {
                    defaultValue: "Only answers questions without modifying files",
                  }) as string)
                : (t("input.runModes.agentDescription", {
                    defaultValue: "Directly process and execute the task",
                  }) as string);

            return (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                disabled={optionDisabled}
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  if (optionDisabled) return;
                  onRunModeChange(option.mode);
                  setIsRunModeMenuOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition",
                  isSelected
                    ? "bg-neutral-100 dark:bg-neutral-800"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-800/70",
                  optionDisabled && "cursor-not-allowed opacity-45",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.9} />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[13px]",
                      isSelected
                        ? "font-bold text-neutral-900 dark:text-neutral-100"
                        : "font-medium text-neutral-700 dark:text-neutral-300",
                    )}
                  >
                    {label}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                    {optionDisabled
                      ? t("input.runModes.planUnavailable", {
                          defaultValue: "Plan mode is only available for Anthropic models.",
                        })
                      : description}
                  </span>
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
