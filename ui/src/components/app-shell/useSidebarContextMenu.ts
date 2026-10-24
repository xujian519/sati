import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { Project, ProjectSession } from "../../types/app";

export type SidebarContextMenu =
  | {
      kind: "project";
      project: Project;
      x: number;
      y: number;
    }
  | {
      kind: "session";
      project: Project;
      session: ProjectSession;
      x: number;
      y: number;
    };

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 88;
const CONTEXT_MENU_MARGIN = 8;

const contextMenuPosition = (event: MouseEvent) => {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientX, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientY, maxY)),
  };
};

/** 侧栏右键菜单：坐标钳制、打开来源、点击/滚动/Escape 关闭。 */
export function useSidebarContextMenu({
  renamingProject,
  renamingSession,
}: {
  renamingProject: string | null;
  renamingSession: string | null;
}) {
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);

  useEffect(() => {
    if (!contextMenu) return undefined;

    const closeContextMenu = () => setContextMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };

    window.addEventListener("click", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("scroll", closeContextMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const openProjectContextMenu = useCallback(
    (event: MouseEvent, project: Project, isGeneral: boolean) => {
      if (isGeneral || renamingProject === project.name) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: "project",
        project,
        x: position.x,
        y: position.y,
      });
    },
    [renamingProject],
  );

  const openSessionContextMenu = useCallback(
    (event: MouseEvent, project: Project, session: ProjectSession) => {
      if (renamingSession === session.id) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: "session",
        project,
        session,
        x: position.x,
        y: position.y,
      });
    },
    [renamingSession],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return { contextMenu, openProjectContextMenu, openSessionContextMenu, closeContextMenu };
}
