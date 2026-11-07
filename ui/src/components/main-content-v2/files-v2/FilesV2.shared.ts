import type { MouseEvent as ReactMouseEvent } from "react";
import type { FileTreeNode } from "../../file-tree/types/types";
import type { Project } from "../../../types/app";

export type FilesV2Props = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  activeFilePath?: string | null;
  onFileRename?: (oldPath: string, newPath: string) => void;
  onFileDelete?: (deletedPath: string) => void;
  onClose?: () => void;
  canAddToChat?: boolean;
};

export type TranslateFunction = (key: string, options?: Record<string, unknown>) => string;

export type FlattenedNode = {
  node: FileTreeNode;
  depth: number;
  parentPath: string;
};

export type FileContextMenu = {
  node: FileTreeNode | null;
  x: number;
  y: number;
};

export type InlineEdit =
  | { kind: "rename"; path: string; currentName: string; depth: number }
  | { kind: "create"; parentPath: string; type: "file" | "directory"; depth: number };

export type ToolbarButtonProps = {
  onClick: (event?: ReactMouseEvent<HTMLButtonElement>) => void;
  label: string;
  disabled?: boolean;
  disabledOpacity?: "40" | "50";
  children: React.ReactNode;
};

export const CONTEXT_MENU_WIDTH = 180;
export const CONTEXT_MENU_HEIGHT = 240;
export const CONTEXT_MENU_MARGIN = 8;

export function clampMenuPosition(x: number, y: number) {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(x, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(y, maxY)),
  };
}

export function flatten(nodes: FileTreeNode[], expanded: Set<string>, depth = 0, parentPath = ""): FlattenedNode[] {
  const out: FlattenedNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth, parentPath });
    if (node.type === "directory" && expanded.has(node.path) && node.children) {
      out.push(...flatten(node.children, expanded, depth + 1, node.path));
    }
  }
  return out;
}
