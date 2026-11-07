import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { ChevronDown, ChevronRight, Download, Eye, FilePlus, Folder, FolderOpen } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import type { FileTreeNode } from "../../file-tree/types/types";
import { getFileIconData } from "../../file-tree/constants/fileIcons";
import type { InlineEdit, TranslateFunction } from "./FilesV2.shared";

const inlineInputClass = cn(
  "min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[13px] outline-hidden",
  "border-brand-400 bg-white text-neutral-900 focus:ring-1 focus:ring-brand-400",
  "dark:border-brand-500 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:ring-brand-500",
);

/** 新建文件/目录时的内联输入行。 */
export function FilesV2InlineCreateRow({
  inlineEdit,
  inputRef,
  onKeyDown,
  onBlur,
}: {
  inlineEdit: Extract<InlineEdit, { kind: "create" }>;
  inputRef: RefObject<HTMLInputElement | null>;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
}) {
  return (
    <li
      style={{ marginLeft: `${inlineEdit.depth * 20}px` }}
      className="flex items-center gap-2 rounded-md px-1.5 py-0.5"
    >
      <span className="w-3.5" />
      {inlineEdit.type === "directory" ? (
        <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
      ) : (
        <FilePlus className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
      )}
      <input ref={inputRef} defaultValue="" onKeyDown={onKeyDown} onBlur={onBlur} className={inlineInputClass} />
    </li>
  );
}

export type FilesV2RowProps = {
  node: FileTreeNode;
  depth: number;
  isOpen: boolean;
  isActive: boolean;
  isRenaming: boolean;
  renameValue: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
  onClick: (node: FileTreeNode) => void;
  onContextMenu: (event: ReactMouseEvent, node: FileTreeNode) => void;
  onDownloadFile: (event: ReactMouseEvent<HTMLButtonElement> | null, node: FileTreeNode) => void;
  onOpenHtmlPreview: (event: ReactMouseEvent<HTMLButtonElement>, node: FileTreeNode) => void;
  t: TranslateFunction;
};

/** 文件树单行（目录/文件、重命名态、行内操作）。 */
export function FilesV2Row({
  node,
  depth,
  isOpen,
  isActive,
  isRenaming,
  renameValue,
  inputRef,
  onKeyDown,
  onBlur,
  onClick,
  onContextMenu,
  onDownloadFile,
  onOpenHtmlPreview,
  t,
}: FilesV2RowProps) {
  const isDir = node.type === "directory";
  const isHtmlFile = !isDir && /\.html?$/i.test(node.name);

  let Icon = Folder;
  let color = "text-neutral-500 dark:text-neutral-400";
  if (isDir) {
    Icon = isOpen ? FolderOpen : Folder;
  } else {
    const iconData = getFileIconData(node.name);
    Icon = iconData.icon;
    color = iconData.color;
  }

  return (
    <li onContextMenu={event => onContextMenu(event, node)}>
      {isRenaming ? (
        <div style={{ marginLeft: `${depth * 20}px` }} className="flex items-center gap-2 rounded-md px-1.5 py-0.5">
          {isDir ? (
            <ChevronRight className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
          ) : (
            <span className="w-3.5" />
          )}
          <Icon className={cn("h-3.5 w-3.5 shrink-0", color)} strokeWidth={1.75} />
          <input
            ref={inputRef}
            defaultValue={renameValue}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            className={inlineInputClass}
          />
        </div>
      ) : (
        <div
          onClick={() => onClick(node)}
          style={{ marginLeft: `${depth * 20}px` }}
          className={cn(
            "group/row flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors",
            isActive ? "bg-neutral-100 dark:bg-neutral-900" : "hover:bg-neutral-50 dark:hover:bg-neutral-900/60",
          )}
        >
          {isDir ? (
            isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            )
          ) : (
            <span className="w-3.5" />
          )}
          <Icon className={cn("h-3.5 w-3.5 shrink-0", color)} strokeWidth={1.75} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              isActive
                ? "font-medium text-neutral-900 dark:text-neutral-100"
                : "text-neutral-700 dark:text-neutral-300",
            )}
          >
            {node.name}
          </span>
          {!isDir && (
            <button
              type="button"
              onClick={event => onDownloadFile(event, node)}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 opacity-0 transition group-hover/row:opacity-100 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              title={t("fileTree.downloadFile")}
              aria-label={t("fileTree.downloadFile")}
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
          {isHtmlFile ? (
            <button
              type="button"
              onClick={event => onOpenHtmlPreview(event, node)}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              title={t("fileTree.openHtmlPreview")}
              aria-label={t("fileTree.openHtmlPreview")}
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}
