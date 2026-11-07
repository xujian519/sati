import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import { logError } from "../../../utils/logging";
import type { Project } from "../../../types/app";
import type { FileTreeNode } from "../../file-tree/types/types";
import { api } from "../../../utils/api";
import { openProjectPreviewInNewTab } from "../../../utils/openProjectPreview";
import { copyTextToClipboard } from "../../../utils/clipboard";
import { ADD_WORKSPACE_FILE_MENTION_EVENT, getWorkspaceRelativePath } from "../../../utils/workspaceFileMention";
import { applyWorkspaceUploadOutcome } from "../workspaceUploadOutcome";
import type { FlattenedNode, TranslateFunction } from "./FilesV2.shared";

export type UseFileOperationsOptions = {
  selectedProject: Project | null;
  projectName: string;
  projectRoot: string;
  canAddToChat: boolean;
  refreshFiles: () => void;
  flat: FlattenedNode[];
  activePath: string | null;
  onFileOpen?: (filePath: string) => void;
  onFileDelete?: (deletedPath: string) => void;
  setActivePath: Dispatch<SetStateAction<string | null>>;
  closeContextMenu: () => void;
  t: TranslateFunction;
};

export function useFileOperations({
  selectedProject,
  projectName,
  projectRoot,
  canAddToChat,
  refreshFiles,
  flat,
  activePath,
  onFileOpen,
  onFileDelete,
  setActivePath,
  closeContextMenu,
  t,
}: UseFileOperationsOptions) {
  const [uploadingProject, setUploadingProject] = useState(false);
  const [downloadingProject, setDownloadingProject] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setUploadMenuOpen(false);
  }, [projectName]);

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const dismiss = () => setUploadMenuOpen(false);
    window.addEventListener("click", dismiss);
    return () => window.removeEventListener("click", dismiss);
  }, [uploadMenuOpen]);

  const setFolderInputRef = useCallback((el: HTMLInputElement | null) => {
    folderInputRef.current = el;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);

  const handleDelete = useCallback(
    async (node: FileTreeNode) => {
      closeContextMenu();
      if (!selectedProject) return;
      const confirmed = window.confirm(
        `Delete "${node.name}"?${node.type === "directory" ? " This will delete all contents." : ""}`,
      );
      if (!confirmed) return;
      try {
        await api.deleteFile(projectName, {
          path: node.path,
          type: node.type === "directory" ? "directory" : "file",
        });
        onFileDelete?.(node.path);
        setActivePath(previous => (previous === node.path || previous?.startsWith(`${node.path}/`) ? null : previous));
        await refreshFiles();
      } catch (error) {
        logError("Delete failed:", error);
      }
    },
    [closeContextMenu, onFileDelete, projectName, refreshFiles, selectedProject, setActivePath],
  );

  const handleCopyPath = useCallback(
    (node: FileTreeNode) => {
      closeContextMenu();
      void copyTextToClipboard(node.path);
    },
    [closeContextMenu],
  );

  const handleOpen = useCallback(
    (node: FileTreeNode) => {
      closeContextMenu();
      setActivePath(node.path);
      onFileOpen?.(node.path);
    },
    [closeContextMenu, onFileOpen, setActivePath],
  );

  const handleAddToChat = useCallback(
    (node: FileTreeNode) => {
      closeContextMenu();
      if (!canAddToChat || !selectedProject?.name || node.type !== "file") return;

      const relativePath = getWorkspaceRelativePath(node.path, projectRoot);
      if (!relativePath) {
        logError("Cannot add file mention outside the current workspace:", node.path);
        return;
      }

      window.dispatchEvent(
        new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
          detail: {
            projectName: selectedProject.name,
            relativePath,
          },
        }),
      );
    },
    [canAddToChat, closeContextMenu, projectRoot, selectedProject?.name],
  );

  const uploadSelectedFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!selectedProject?.name || !fileList || fileList.length === 0) return;

      const fileArray = Array.from(fileList);
      const relativePaths = fileArray.map(file => {
        const withDir = file as File & { webkitRelativePath?: string };
        return withDir.webkitRelativePath || file.name;
      });

      const formData = new FormData();
      formData.append("targetPath", "");
      formData.append("relativePaths", JSON.stringify(relativePaths));
      for (const file of fileArray) {
        formData.append("files", file);
      }

      try {
        setUploadingProject(true);
        setUploadMenuOpen(false);
        await applyWorkspaceUploadOutcome(await api.uploadFiles(selectedProject.name, formData), {
          refresh: refreshFiles,
          translate: t,
        });
      } catch (error) {
        logError("Failed to upload files:", error);
      } finally {
        setUploadingProject(false);
      }
    },
    [refreshFiles, selectedProject?.name, t],
  );

  const handleDownloadProject = useCallback(async () => {
    if (!selectedProject?.name || downloadingProject) return;

    try {
      setDownloadingProject(true);
      const response = await api.downloadProjectZip(selectedProject.name);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${selectedProject.displayName || selectedProject.name}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (error) {
      logError("Failed to download project archive:", error);
    } finally {
      setDownloadingProject(false);
    }
  }, [downloadingProject, selectedProject?.displayName, selectedProject?.name]);

  const handleOpenHtmlPreview = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, node: FileTreeNode) => {
      event.stopPropagation();
      if (!selectedProject?.name) return;
      openProjectPreviewInNewTab(selectedProject.name, node.path, projectRoot);
    },
    [projectRoot, selectedProject?.name],
  );

  const handleDownloadFile = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement> | null, node: FileTreeNode) => {
      event?.stopPropagation();
      if (!selectedProject?.name || node.type === "directory") return;

      const url = await api.fileDownloadUrl(selectedProject.name, node.path);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = node.name;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    },
    [selectedProject?.name],
  );

  const handleDeleteActive = useCallback(() => {
    if (!activePath) return;
    const activeNode = flat.find(f => f.node.path === activePath);
    if (activeNode) handleDelete(activeNode.node);
  }, [activePath, flat, handleDelete]);

  return {
    uploadingProject,
    downloadingProject,
    uploadMenuOpen,
    setUploadMenuOpen,
    fileInputRef,
    folderInputRef,
    setFolderInputRef,
    handleDelete,
    handleCopyPath,
    handleOpen,
    handleAddToChat,
    uploadSelectedFiles,
    handleDownloadProject,
    handleOpenHtmlPreview,
    handleDownloadFile,
    handleDeleteActive,
  };
}
