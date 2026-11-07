import { Fragment, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useFileTreeData } from "../file-tree/hooks/useFileTreeData";
import type { FileTreeNode } from "../file-tree/types/types";
import { FilesV2ContextMenu } from "./files-v2/FilesV2ContextMenu";
import { FilesV2InlineCreateRow, FilesV2Row } from "./files-v2/FilesV2Row";
import { FilesV2Toolbar } from "./files-v2/FilesV2Toolbar";
import type { FilesV2Props } from "./files-v2/FilesV2.shared";
import { useFileContextMenu } from "./files-v2/useFileContextMenu";
import { useFileInlineEdit } from "./files-v2/useFileInlineEdit";
import { useFileOperations } from "./files-v2/useFileOperations";
import { useFileTreeExpansion } from "./files-v2/useFileTreeExpansion";

export type { FilesV2Props } from "./files-v2/FilesV2.shared";

export default function FilesV2({
  selectedProject,
  onFileOpen,
  activeFilePath,
  onFileRename,
  onFileDelete,
  onClose,
  canAddToChat = true,
}: FilesV2Props) {
  const { t } = useTranslation();
  const { files, loading, unavailable, refreshFiles } = useFileTreeData(selectedProject);

  const projectName = selectedProject?.name ?? "";
  const projectRoot = selectedProject?.fullPath || selectedProject?.path || "";

  const expansion = useFileTreeExpansion({
    files,
    projectName: selectedProject?.name,
    activeFilePath,
    onFileOpen,
  });
  const inline = useFileInlineEdit({
    hasProject: selectedProject !== null,
    projectName,
    refreshFiles,
    onFileRename,
    ensureExpanded: expansion.ensureExpanded,
  });
  const menu = useFileContextMenu();
  const ops = useFileOperations({
    selectedProject,
    projectName,
    projectRoot,
    canAddToChat,
    refreshFiles,
    flat: expansion.flat,
    activePath: expansion.activePath,
    onFileOpen,
    onFileDelete,
    setActivePath: expansion.setActivePath,
    closeContextMenu: menu.closeContextMenu,
    t,
  });

  const { ensureExpanded } = expansion;
  const { setInlineEdit } = inline;
  const closeContextMenu = menu.closeContextMenu;

  // 项目切换时关闭右键菜单（其余状态由各自 hook 在同一依赖上重置）。
  useEffect(() => {
    closeContextMenu();
  }, [selectedProject?.name, closeContextMenu]);

  const depthByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const { node, depth } of expansion.flat) {
      map.set(node.path, depth);
    }
    return map;
  }, [expansion.flat]);

  const handleNewFile = useCallback(
    (parentPath: string, depth: number) => {
      closeContextMenu();
      ensureExpanded(parentPath);
      setInlineEdit({ kind: "create", parentPath, type: "file", depth });
    },
    [ensureExpanded, setInlineEdit, closeContextMenu],
  );

  const handleNewFolder = useCallback(
    (parentPath: string, depth: number) => {
      closeContextMenu();
      ensureExpanded(parentPath);
      setInlineEdit({ kind: "create", parentPath, type: "directory", depth });
    },
    [ensureExpanded, setInlineEdit, closeContextMenu],
  );

  const handleRename = useCallback(
    (node: FileTreeNode, depth: number) => {
      closeContextMenu();
      setInlineEdit({ kind: "rename", path: node.path, currentName: node.name, depth });
    },
    [setInlineEdit, closeContextMenu],
  );

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t("fileTree.selectProject")}
      </div>
    );
  }

  const cwd = selectedProject.fullPath || selectedProject.path || selectedProject.name;
  const hasExpanded = expansion.expanded.size > 0;

  const findInsertIndex = (parentPath: string): number => {
    if (!parentPath) return expansion.flat.length;
    const parentIdx = expansion.flat.findIndex(f => f.node.path === parentPath);
    if (parentIdx === -1) return expansion.flat.length;
    const parentDepth = expansion.flat[parentIdx].depth;
    let i = parentIdx + 1;
    while (i < expansion.flat.length && expansion.flat[i].depth > parentDepth) i++;
    return i;
  };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <FilesV2Toolbar
        cwd={cwd}
        loading={loading}
        hasExpanded={hasExpanded}
        hasActivePath={expansion.activePath !== null}
        uploadingProject={ops.uploadingProject}
        downloadingProject={ops.downloadingProject}
        uploadMenuOpen={ops.uploadMenuOpen}
        onNewFile={() => handleNewFile("", 0)}
        onNewFolder={() => handleNewFolder("", 0)}
        onToggleUploadMenu={event => {
          event?.stopPropagation();
          ops.setUploadMenuOpen(open => !open);
        }}
        onPickFile={() => {
          ops.setUploadMenuOpen(false);
          ops.fileInputRef.current?.click();
        }}
        onPickFolder={() => {
          ops.setUploadMenuOpen(false);
          ops.folderInputRef.current?.click();
        }}
        onUploadChange={files => void ops.uploadSelectedFiles(files)}
        fileInputRef={ops.fileInputRef}
        setFolderInputRef={ops.setFolderInputRef}
        onDownloadProject={ops.handleDownloadProject}
        onDeleteActive={ops.handleDeleteActive}
        onRefresh={refreshFiles}
        onCollapseAll={expansion.collapseAll}
        onClose={onClose}
        t={t}
      />

      <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[13px]" onContextMenu={menu.handleBlankContextMenu}>
        {loading && files.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t("fileTree.loading")}</span>
          </div>
        ) : expansion.flat.length === 0 ? (
          <div className="py-6 text-center text-xxs text-neutral-500 dark:text-neutral-400">
            {t(unavailable ? "fileTree.unavailable" : "fileTree.empty")}
          </div>
        ) : (
          <ul className="space-y-0.5 px-4">
            {expansion.flat.map(({ node, depth }, idx) => {
              const isDir = node.type === "directory";
              const isRenaming = inline.inlineEdit?.kind === "rename" && inline.inlineEdit.path === node.path;
              const showCreateAfter =
                inline.inlineEdit?.kind === "create" && findInsertIndex(inline.inlineEdit.parentPath) === idx + 1;
              return (
                <Fragment key={node.path}>
                  <FilesV2Row
                    node={node}
                    depth={depth}
                    isOpen={isDir && expansion.expanded.has(node.path)}
                    isActive={expansion.activePath === node.path}
                    isRenaming={isRenaming}
                    renameValue={inline.inlineEdit?.kind === "rename" ? inline.inlineEdit.currentName : ""}
                    inputRef={inline.inlineInputRef}
                    onKeyDown={inline.handleInlineKeyDown}
                    onBlur={inline.handleInlineBlur}
                    onClick={expansion.handleClick}
                    onContextMenu={menu.handleContextMenu}
                    onDownloadFile={ops.handleDownloadFile}
                    onOpenHtmlPreview={ops.handleOpenHtmlPreview}
                    t={t}
                  />
                  {showCreateAfter && inline.inlineEdit?.kind === "create" ? (
                    <FilesV2InlineCreateRow
                      inlineEdit={inline.inlineEdit}
                      inputRef={inline.inlineInputRef}
                      onKeyDown={inline.handleInlineKeyDown}
                      onBlur={inline.handleInlineBlur}
                    />
                  ) : null}
                </Fragment>
              );
            })}
            {inline.inlineEdit?.kind === "create" && expansion.flat.length === 0 ? (
              <FilesV2InlineCreateRow
                inlineEdit={inline.inlineEdit}
                inputRef={inline.inlineInputRef}
                onKeyDown={inline.handleInlineKeyDown}
                onBlur={inline.handleInlineBlur}
              />
            ) : null}
          </ul>
        )}
      </div>

      {menu.contextMenu ? (
        <FilesV2ContextMenu
          contextMenu={menu.contextMenu}
          depthByPath={depthByPath}
          canAddToChat={canAddToChat}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onOpen={ops.handleOpen}
          onDownloadFile={ops.handleDownloadFile}
          onRename={handleRename}
          onCopyPath={ops.handleCopyPath}
          onAddToChat={ops.handleAddToChat}
          onDelete={ops.handleDelete}
          t={t}
        />
      ) : null}
    </div>
  );
}
