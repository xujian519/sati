import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { Project } from "../../../types/app";

type KanbanWorkspacePickerProps = {
  projects: Project[];
  /** 当前项目根目录；移动列表里会过滤掉它。 */
  excludePath?: string;
  onSelect: (projectPath: string) => void;
  onClose: () => void;
};

/**
 * 把卡片"移动到其他工作区"的选择器。
 * 目标用项目根目录（Project.path）作为 gateway 的 toProjectKey。
 */
export function KanbanWorkspacePicker({ projects, excludePath, onSelect, onClose }: KanbanWorkspacePickerProps) {
  const { t } = useTranslation();
  const targets = projects.filter(project => {
    const projectPath = project.path || project.fullPath;
    return Boolean(projectPath && projectPath !== excludePath);
  });

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            {t("kanban:moveToWorkspace.title", { defaultValue: "移动到其他工作区" })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label={t("close", { defaultValue: "关闭" })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {targets.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-neutral-400 dark:text-neutral-500">
              {t("kanban:moveToWorkspace.empty", { defaultValue: "没有可移动的其他工作区" })}
            </p>
          ) : (
            targets.map(project => {
              const projectPath = project.path || project.fullPath;
              return (
                <button
                  key={project.name}
                  type="button"
                  onClick={() => projectPath && onSelect(projectPath)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                >
                  <span className="min-w-0 flex-1 truncate">{project.displayName || project.name}</span>
                  <span className="truncate text-xs text-neutral-400">{projectPath}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
