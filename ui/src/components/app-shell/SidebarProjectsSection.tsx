import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { ChevronsDownUp, ChevronsUpDown, Folder, Plus } from "lucide-react";
import type { Project } from "../../types/app";

/** Projects 分区（#646 B3.1）：标题行 + 空态 + 项目组列表。 */
export default function SidebarProjectsSection({
  t,
  otherProjects,
  allProjectGroupsExpanded,
  toggleAllProjectGroups,
  onCreateProject,
  renderProjectGroup,
}: {
  t: TFunction;
  otherProjects: Project[];
  allProjectGroupsExpanded: boolean;
  toggleAllProjectGroups: () => void;
  onCreateProject: () => void;
  renderProjectGroup: (project: Project) => ReactNode;
}) {
  return (
    <section className="pt-2">
      <div className="flex items-center px-3 pb-1">
        <span className="flex-1 text-[11px] font-medium tracking-[0.04em] text-neutral-500/90 uppercase dark:text-neutral-400/80">
          {t("sidebar:projects.title", { defaultValue: "Projects" })}
        </span>
        <button
          type="button"
          onClick={toggleAllProjectGroups}
          disabled={otherProjects.length === 0}
          aria-label={
            allProjectGroupsExpanded
              ? (t("sidebar:projects.collapseAll", { defaultValue: "Collapse all projects" }) as string)
              : (t("sidebar:projects.expandAll", { defaultValue: "Expand all projects" }) as string)
          }
          title={
            allProjectGroupsExpanded
              ? (t("sidebar:projects.collapseAll", { defaultValue: "Collapse all projects" }) as string)
              : (t("sidebar:projects.expandAll", { defaultValue: "Expand all projects" }) as string)
          }
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {allProjectGroupsExpanded ? (
            <ChevronsDownUp className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : (
            <ChevronsUpDown className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          onClick={onCreateProject}
          aria-label={t("sidebar:projects.newProject", { defaultValue: "New Project" }) as string}
          title={t("sidebar:projects.newProject", { defaultValue: "New Project" }) as string}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {otherProjects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Folder className="h-8 w-8 text-neutral-300 dark:text-neutral-700" strokeWidth={1.5} />
          <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
            {t("sidebar:projects.noProjects", { defaultValue: "No projects found" })}
          </div>
          <button
            type="button"
            onClick={onCreateProject}
            className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-3 py-1.5 text-[12px] font-medium text-brand-600 transition-colors hover:bg-brand-100 dark:bg-brand-900/20 dark:text-brand-400 dark:hover:bg-brand-900/40"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            {t("sidebar:projects.newProject", { defaultValue: "New Project" })}
          </button>
        </div>
      ) : (
        <div className="space-y-0.5">{otherProjects.map(project => renderProjectGroup(project))}</div>
      )}
    </section>
  );
}
