import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import {
  Box,
  ChevronsDownUp,
  Download,
  FilePlus,
  FolderPlus,
  Loader2,
  PanelLeftClose,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "../../../lib/utils.js";
import type { ToolbarButtonProps, TranslateFunction } from "./FilesV2.shared";

function ToolbarButton({ onClick, label, disabled, disabledOpacity = "50", children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900",
        disabledOpacity === "40" ? "disabled:opacity-40" : "disabled:opacity-50",
      )}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

export type FilesV2ToolbarProps = {
  cwd: string;
  loading: boolean;
  hasExpanded: boolean;
  hasActivePath: boolean;
  uploadingProject: boolean;
  downloadingProject: boolean;
  uploadMenuOpen: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
  onToggleUploadMenu: (event?: ReactMouseEvent<HTMLButtonElement>) => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  onUploadChange: (files: FileList | null) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  setFolderInputRef: (el: HTMLInputElement | null) => void;
  onDownloadProject: () => void;
  onDeleteActive: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
  onClose?: () => void;
  t: TranslateFunction;
};

export function FilesV2Toolbar({
  cwd,
  loading,
  hasExpanded,
  hasActivePath,
  uploadingProject,
  downloadingProject,
  uploadMenuOpen,
  onNewFile,
  onNewFolder,
  onToggleUploadMenu,
  onPickFile,
  onPickFolder,
  onUploadChange,
  fileInputRef,
  setFolderInputRef,
  onDownloadProject,
  onDeleteActive,
  onRefresh,
  onCollapseAll,
  onClose,
  t,
}: FilesV2ToolbarProps) {
  return (
    <div className="shrink-0 border-b border-neutral-200 dark:border-neutral-800">
      <div className="flex h-7 items-center gap-1.5 px-3 pt-1">
        <Box className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.75} />
        <span className="truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">{cwd}</span>
      </div>
      <div className="flex items-center gap-1 px-3 pb-1">
        <ToolbarButton onClick={onNewFile} label={t("fileTree.context.newFile")}>
          <FilePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </ToolbarButton>
        <ToolbarButton onClick={onNewFolder} label={t("fileTree.context.newFolder")}>
          <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </ToolbarButton>
        <div className="relative">
          <ToolbarButton onClick={onToggleUploadMenu} disabled={uploadingProject} label={t("fileTree.upload")}>
            {uploadingProject ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </ToolbarButton>
          {uploadMenuOpen ? (
            <div className="absolute top-8 left-0 z-20 w-36 rounded-md border border-neutral-200 bg-white py-1 text-[12px] shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation();
                  onPickFile();
                }}
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                {t("fileTree.uploadFiles")}
              </button>
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation();
                  onPickFolder();
                }}
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                {t("fileTree.uploadFolder")}
              </button>
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => {
              onUploadChange(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={setFolderInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => {
              onUploadChange(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </div>
        <ToolbarButton onClick={onDownloadProject} disabled={downloadingProject} label={t("fileTree.downloadProject")}>
          {downloadingProject ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </ToolbarButton>
        <ToolbarButton
          onClick={onDeleteActive}
          disabled={!hasActivePath}
          disabledOpacity="40"
          label={t("fileTree.deleteSelected")}
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </ToolbarButton>
        <ToolbarButton onClick={onRefresh} disabled={loading} label={t("fileTree.refresh")}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} strokeWidth={1.75} />
        </ToolbarButton>
        <ToolbarButton
          onClick={onCollapseAll}
          disabled={!hasExpanded}
          disabledOpacity="40"
          label={t("fileTree.collapseAll")}
        >
          <ChevronsDownUp className="h-3.5 w-3.5" strokeWidth={1.75} />
        </ToolbarButton>
        {onClose ? (
          <ToolbarButton onClick={onClose} label={t("fileTree.collapsePanel")}>
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.8} />
          </ToolbarButton>
        ) : null}
      </div>
    </div>
  );
}
