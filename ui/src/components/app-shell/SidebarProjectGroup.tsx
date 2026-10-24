import type { TFunction } from "i18next";
import { Folder, MessageSquarePlus } from "lucide-react";
import type { Project } from "../../types/app";
import { cn } from "../../lib/utils.js";
import { projectDisplayName } from "../../lib/customNames";

export type SidebarProjectGroupProps = {
  project: Project;
  isGeneral?: boolean;
  selectedProject: Project | null;
  expandedGroups: Set<string>;
  renamingProject: string | null;
  renameDraft: string;
  setRenameDraft: (value: string) => void;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  commitProjectRename: () => void;
  handleRenameKey: (event: React.KeyboardEvent<HTMLInputElement>, kind: "project" | "session") => void;
  handleProjectClick: (project: Project) => void;
  handleNewSession: (event: React.MouseEvent, project: Project) => void;
  openProjectContextMenu: (event: React.MouseEvent, project: Project, isGeneral: boolean) => void;
  renderSessionRows: (project: Project) => React.ReactNode;
  t: TFunction;
};

/** 项目折叠组（#646 B3.1）：从 SidebarV2.renderProjectGroup 原样外置。 */
export default function SidebarProjectGroup({
  project,
  isGeneral = false,
  selectedProject,
  expandedGroups,
  renamingProject,
  renameDraft,
  setRenameDraft,
  renameInputRef,
  commitProjectRename,
  handleRenameKey,
  handleProjectClick,
  handleNewSession,
  openProjectContextMenu,
  renderSessionRows,
  t,
}: SidebarProjectGroupProps) {
  const isSelected = project.name === selectedProject?.name;
  const isExpanded = expandedGroups.has(project.name);
  const isRenaming = renamingProject === project.name;
  const label = isGeneral ? t("sidebar:general.name", { defaultValue: "General" }) : projectDisplayName(project);

  return (
    <div key={project.name} className="space-y-0.5">
      <div
        onContextMenu={event => openProjectContextMenu(event, project, isGeneral)}
        className={cn(
          "group/project relative flex h-9 w-full items-center rounded-lg border-l-[3px] pr-1.5 text-[13px] transition-all duration-200",
          isSelected
            ? "border-brand-500 bg-gradient-to-r from-brand-50 to-brand-50/30 font-medium text-neutral-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:from-brand-900/30 dark:to-brand-900/5 dark:text-neutral-100"
            : "border-transparent text-neutral-700 hover:border-neutral-200 hover:bg-neutral-100/80 dark:text-neutral-300 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/60",
        )}
      >
        {isRenaming && !isGeneral ? (
          <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-2">
            <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            <input
              ref={renameInputRef}
              value={renameDraft}
              onChange={event => setRenameDraft(event.target.value)}
              onBlur={commitProjectRename}
              onKeyDown={event => handleRenameKey(event, "project")}
              onClick={event => event.stopPropagation()}
              placeholder={t("sidebar:renamePlaceholder", { defaultValue: "Rename - empty to reset" }) as string}
              className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-hidden focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => handleProjectClick(project)}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-lg pr-1 pl-2 text-left"
          >
            <Folder
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-colors",
                isSelected ? "text-brand-600 dark:text-brand-300" : "text-neutral-500 dark:text-neutral-400",
              )}
              strokeWidth={1.75}
            />
            <span className="flex-1 truncate">{label}</span>
          </button>
        )}

        {!isRenaming ? (
          <div
            className={cn(
              "ml-1 flex shrink-0 items-center gap-0.5 transition-opacity duration-150",
              "[@media(hover:none)]:opacity-100",
              isSelected ? "opacity-100" : "opacity-0 group-hover/project:opacity-100 focus-within:opacity-100",
            )}
          >
            <button
              type="button"
              onClick={event => handleNewSession(event, project)}
              aria-label={t("sidebar:tooltips.newChat", { defaultValue: "New Chat" }) as string}
              title={t("sidebar:tooltips.newChat", { defaultValue: "New Chat" }) as string}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-md",
                "text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900",
                "dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100",
              )}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        ) : null}
      </div>

      {isExpanded ? renderSessionRows(project) : null}
    </div>
  );
}
