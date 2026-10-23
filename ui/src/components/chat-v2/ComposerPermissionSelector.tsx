import type { TFunction } from "i18next";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { PermissionMode } from "../chat/types/types";
import { cn } from "../../lib/utils.js";
import { PERMISSION_MODE_OPTIONS } from "./composerOptions";

type ComposerPermissionSelectorProps = {
  isPermissionMenuOpen: boolean;
  setIsPermissionMenuOpen: Dispatch<SetStateAction<boolean>>;
  permissionSelectorDisabled: boolean;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  selectedPermissionLabel: string;
  SelectedPermissionIcon: LucideIcon;
  t: TFunction<"chat">;
};

export default function ComposerPermissionSelector({
  isPermissionMenuOpen,
  setIsPermissionMenuOpen,
  permissionSelectorDisabled,
  permissionMode,
  onPermissionModeChange,
  selectedPermissionLabel,
  SelectedPermissionIcon,
  t,
}: ComposerPermissionSelectorProps) {
  return (
    <div
      className="relative"
      onBlur={event => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          setIsPermissionMenuOpen(false);
        }
      }}
    >
      <button
        type="button"
        disabled={permissionSelectorDisabled}
        onClick={() => {
          if (permissionSelectorDisabled) return;
          setIsPermissionMenuOpen(open => !open);
        }}
        className={cn(
          "pd-composer-icon-button inline-flex h-7 max-w-[132px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[190px]",
          permissionSelectorDisabled
            ? "cursor-not-allowed text-neutral-400 opacity-45 dark:text-neutral-500"
            : permissionMode === "bypassPermissions"
              ? "text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
              : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
        )}
        title={
          t("input.permissions.change", {
            defaultValue: "Select permission mode",
          }) as string
        }
        aria-haspopup="menu"
        aria-expanded={permissionSelectorDisabled ? false : isPermissionMenuOpen}
      >
        <SelectedPermissionIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <span className="pd-composer-permission-label truncate">{selectedPermissionLabel}</span>
        <ChevronDown
          className={cn(
            "pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform",
            isPermissionMenuOpen && "rotate-180",
          )}
          strokeWidth={2}
        />
      </button>
      {isPermissionMenuOpen ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-60 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {PERMISSION_MODE_OPTIONS.map(option => {
            const Icon = option.Icon;
            const isSelected = permissionMode === option.mode;
            const isDangerous = option.mode === "bypassPermissions";
            const label = t(option.labelKey, {
              defaultValue: option.defaultLabel,
            }) as string;
            const description = t(option.descriptionKey, {
              defaultValue: option.defaultDescription,
            }) as string;

            return (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  onPermissionModeChange(option.mode);
                  setIsPermissionMenuOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition",
                  isSelected
                    ? "bg-neutral-100 dark:bg-neutral-800"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-800/70",
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isDangerous ? "text-amber-600 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400",
                  )}
                  strokeWidth={1.9}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[13px] font-medium",
                      isDangerous ? "text-amber-700 dark:text-amber-300" : "text-neutral-900 dark:text-neutral-100",
                    )}
                  >
                    {label}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                    {description}
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
