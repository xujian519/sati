import { useCallback, useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { FileTreeNode } from "../../file-tree/types/types";
import { clampMenuPosition, type FileContextMenu } from "./FilesV2.shared";

export function useFileContextMenu() {
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextMenu = useCallback((event: ReactMouseEvent, node: FileTreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    const pos = clampMenuPosition(event.clientX, event.clientY);
    setContextMenu({ node, x: pos.x, y: pos.y });
  }, []);

  const handleBlankContextMenu = useCallback((event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest("li")) return;
    event.preventDefault();
    const pos = clampMenuPosition(event.clientX, event.clientY);
    setContextMenu({ node: null, x: pos.x, y: pos.y });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => closeContextMenu();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu, closeContextMenu]);

  return {
    contextMenu,
    closeContextMenu,
    handleContextMenu,
    handleBlankContextMenu,
  };
}
