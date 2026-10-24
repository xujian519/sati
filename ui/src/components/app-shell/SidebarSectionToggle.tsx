import type { TFunction } from "i18next";
import { cn } from "../../lib/utils.js";

/** Projects / General 分段切换（#646 B3.1）。 */
export default function SidebarSectionToggle({
  t,
  activeSection,
  handleProjectsSectionClick,
  handleGeneralSectionClick,
}: {
  t: TFunction;
  activeSection: "projects" | "general";
  handleProjectsSectionClick: () => void;
  handleGeneralSectionClick: () => void;
}) {
  return (
    <div className="px-3 pt-3 pb-1">
      <div
        role="tablist"
        aria-label={t("sidebar:sectionToggle.label", { defaultValue: "Sidebar section" }) as string}
        className="relative flex w-full rounded-lg bg-neutral-200/60 p-0.5 ring-1 ring-neutral-200/80 dark:bg-neutral-800/60 dark:ring-neutral-800/80"
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded-md bg-white shadow-xs ring-1 ring-neutral-200/80 transition-transform duration-300 ease-out dark:bg-neutral-700 dark:ring-neutral-600/80",
            activeSection === "general" && "translate-x-full",
          )}
        />
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === "projects"}
          onClick={handleProjectsSectionClick}
          className={cn(
            "relative z-10 flex-1 rounded-md text-[12px] font-medium transition-colors duration-200",
            "h-7 leading-none",
            activeSection === "projects"
              ? "text-brand-600 dark:text-brand-300"
              : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
          )}
        >
          {t("sidebar:projects.title", { defaultValue: "Projects" })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === "general"}
          onClick={handleGeneralSectionClick}
          className={cn(
            "relative z-10 flex-1 rounded-md text-[12px] font-medium transition-colors duration-200",
            "h-7 leading-none",
            activeSection === "general"
              ? "text-brand-600 dark:text-brand-300"
              : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
          )}
        >
          {t("sidebar:general.title", { defaultValue: "General" })}
        </button>
      </div>
    </div>
  );
}
