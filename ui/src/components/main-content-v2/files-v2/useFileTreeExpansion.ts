import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileTreeNode } from "../../file-tree/types/types";
import { flatten } from "./FilesV2.shared";

export type UseFileTreeExpansionOptions = {
  files: FileTreeNode[];
  /** 项目切换时重置展开/选中（用 name 而非对象，避免同项目刷新触发重置）。 */
  projectName: string | undefined;
  activeFilePath: string | null | undefined;
  onFileOpen?: (filePath: string) => void;
};

export function useFileTreeExpansion({ files, projectName, activeFilePath, onFileOpen }: UseFileTreeExpansionOptions) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(new Set());
    setActivePath(null);
  }, [projectName]);

  useEffect(() => {
    if (activeFilePath !== undefined) {
      setActivePath(activeFilePath);
    }
  }, [activeFilePath]);

  const flat = useMemo(() => flatten(files, expanded), [files, expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const ensureExpanded = useCallback((path: string) => {
    if (!path) return;
    setExpanded(prev => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const handleClick = useCallback(
    (node: FileTreeNode) => {
      setActivePath(node.path);
      if (node.type === "directory") {
        toggle(node.path);
        return;
      }
      onFileOpen?.(node.path);
    },
    [onFileOpen, toggle],
  );

  return {
    expanded,
    activePath,
    setActivePath,
    flat,
    toggle,
    collapseAll,
    ensureExpanded,
    handleClick,
  };
}
