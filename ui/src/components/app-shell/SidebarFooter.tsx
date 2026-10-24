import type { TFunction } from "i18next";
import { Settings as SettingsIcon, Users } from "lucide-react";
import { cn } from "../../lib/utils.js";

/** 侧栏底部入口（#646 B3.1）：Team / Settings。 */
export default function SidebarFooter({
  t,
  onOpenTeamPanel,
  isTeamPanelOpen,
  onShowSettings,
}: {
  t: TFunction;
  onOpenTeamPanel?: () => void;
  isTeamPanelOpen?: boolean;
  onShowSettings: () => void;
}) {
  return (
    <div className="border-t border-neutral-200/80 bg-gradient-to-b from-transparent to-neutral-100/40 px-2 py-2.5 dark:border-neutral-800/80 dark:to-neutral-950/40">
      {onOpenTeamPanel ? (
        <button
          type="button"
          onClick={onOpenTeamPanel}
          aria-pressed={isTeamPanelOpen}
          aria-label={t("tabs.team", { defaultValue: "Team" }) as string}
          title={t("tabs.team", { defaultValue: "Team" }) as string}
          className={cn(
            "group flex h-9 w-full items-center justify-start gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-all duration-200",
            isTeamPanelOpen
              ? "bg-brand-50 text-brand-600 dark:bg-brand-900/30 dark:text-brand-300"
              : "text-neutral-600 hover:bg-white hover:text-brand-600 hover:shadow-xs dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-brand-300",
          )}
        >
          <span
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md transition",
              isTeamPanelOpen
                ? "bg-brand-100 text-brand-600 dark:bg-brand-900/50 dark:text-brand-300"
                : "bg-neutral-200/60 group-hover:bg-brand-50 group-hover:text-brand-600 dark:bg-neutral-800/60 dark:group-hover:bg-brand-900/30 dark:group-hover:text-brand-300",
            )}
          >
            <Users className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
          <span>{t("tabs.team", { defaultValue: "Team" })}</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={onShowSettings}
        aria-label={t("sidebar:actions.settings", { defaultValue: "Settings" }) as string}
        title={t("sidebar:actions.settings", { defaultValue: "Settings" }) as string}
        className="group flex h-9 w-full items-center justify-start gap-2.5 rounded-lg px-3 text-[13px] font-medium text-neutral-600 transition-all duration-200 hover:bg-white hover:text-brand-600 hover:shadow-xs dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-brand-300"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-200/60 transition group-hover:bg-brand-50 group-hover:text-brand-600 dark:bg-neutral-800/60 dark:group-hover:bg-brand-900/30 dark:group-hover:text-brand-300">
          <SettingsIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <span>{t("sidebar:actions.settings", { defaultValue: "Settings" })}</span>
      </button>
    </div>
  );
}
