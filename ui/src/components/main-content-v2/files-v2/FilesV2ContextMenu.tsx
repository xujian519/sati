import { ClipboardCopy, Download, FilePlus, FolderPlus, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import type { FileTreeNode } from "../../file-tree/types/types";
import type { FileContextMenu, TranslateFunction } from "./FilesV2.shared";

export type FilesV2ContextMenuProps = {
  contextMenu: FileContextMenu;
  depthByPath: Map<string, number>;
  canAddToChat: boolean;
  onNewFile: (parentPath: string, depth: number) => void;
  onNewFolder: (parentPath: string, depth: number) => void;
  onOpen: (node: FileTreeNode) => void;
  onDownloadFile: (event: null, node: FileTreeNode) => void;
  onRename: (node: FileTreeNode, depth: number) => void;
  onCopyPath: (node: FileTreeNode) => void;
  onAddToChat: (node: FileTreeNode) => void;
  onDelete: (node: FileTreeNode) => void;
  t: TranslateFunction;
};

const menuItemClass = cn(
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
  "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
);
const menuIconClass = "h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400";

export function FilesV2ContextMenu({
  contextMenu,
  depthByPath,
  canAddToChat,
  onNewFile,
  onNewFolder,
  onOpen,
  onDownloadFile,
  onRename,
  onCopyPath,
  onAddToChat,
  onDelete,
  t,
}: FilesV2ContextMenuProps) {
  const node = contextMenu.node;
  return (
    <div
      role="menu"
      aria-label={t("fileTree.context.menuLabel")}
      onClick={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
      className={cn(
        "fixed z-50 w-44 rounded-lg border bg-white p-1 shadow-lg",
        "border-neutral-200 dark:border-neutral-700 dark:bg-neutral-900",
      )}
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      {node ? (
        <>
          {node.type === "directory" ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => onNewFile(node.path, (depthByPath.get(node.path) ?? 0) + 1)}
                className={menuItemClass}
              >
                <FilePlus className={menuIconClass} strokeWidth={1.75} />
                {t("fileTree.context.newFile")}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => onNewFolder(node.path, (depthByPath.get(node.path) ?? 0) + 1)}
                className={menuItemClass}
              >
                <FolderPlus className={menuIconClass} strokeWidth={1.75} />
                {t("fileTree.context.newFolder")}
              </button>
              <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => onOpen(node)} className={menuItemClass}>
                <FilePlus className={menuIconClass} strokeWidth={1.75} />
                Open
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => onDownloadFile(null, node)}
                className={menuItemClass}
              >
                <Download className={menuIconClass} strokeWidth={1.75} />
                {t("fileTree.context.download")}
              </button>
              <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => onRename(node, depthByPath.get(node.path) ?? 0)}
            className={menuItemClass}
          >
            <Pencil className={menuIconClass} strokeWidth={1.75} />
            {t("fileTree.context.rename")}
          </button>
          <button type="button" role="menuitem" onClick={() => onCopyPath(node)} className={menuItemClass}>
            <ClipboardCopy className={menuIconClass} strokeWidth={1.75} />
            {t("fileTree.context.copyPath")}
          </button>
          {node.type === "file" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!canAddToChat}
              onClick={() => onAddToChat(node)}
              className={cn(menuItemClass, !canAddToChat && "pointer-events-none cursor-not-allowed opacity-45")}
            >
              <MessageSquarePlus className={menuIconClass} strokeWidth={1.75} />
              {t("fileTree.context.addToChat")}
            </button>
          ) : null}
          <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => onDelete(node)}
            className={cn(menuItemClass, "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30")}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {t("fileTree.context.delete")}
          </button>
        </>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={() => onNewFile("", 0)} className={menuItemClass}>
            <FilePlus className={menuIconClass} strokeWidth={1.75} />
            {t("fileTree.context.newFile")}
          </button>
          <button type="button" role="menuitem" onClick={() => onNewFolder("", 0)} className={menuItemClass}>
            <FolderPlus className={menuIconClass} strokeWidth={1.75} />
            {t("fileTree.context.newFolder")}
          </button>
        </>
      )}
    </div>
  );
}
