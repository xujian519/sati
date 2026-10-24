import type { TFunction } from "i18next";
import { Pencil, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils.js";
import type { SidebarContextMenu as SidebarContextMenuState } from "./useSidebarContextMenu";

/** 右键菜单浮层（#646 B3.1）：Rename / Delete。 */
export default function SidebarContextMenu({
  contextMenu,
  onRename,
  onDelete,
  t,
}: {
  contextMenu: SidebarContextMenuState;
  onRename: () => void;
  onDelete: () => void;
  t: TFunction;
}) {
  return (
    <div
      role="menu"
      aria-label={t("sidebar:contextMenu.label", { defaultValue: "Context menu" }) as string}
      onClick={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
      className={cn(
        "fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg",
        "dark:border-neutral-700 dark:bg-neutral-900",
      )}
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
          "text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800",
        )}
      >
        <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
        <span>{t("sidebar:actions.rename", { defaultValue: "Rename" })}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
          "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40",
        )}
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        <span>{t("sidebar:actions.delete", { defaultValue: "Delete" })}</span>
      </button>
    </div>
  );
}
