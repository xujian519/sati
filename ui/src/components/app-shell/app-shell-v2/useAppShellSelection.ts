import { useCallback, useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { Project } from "../../../types/app";
import { chooseDefaultProject } from "../appShellSelection";

type UseAppShellSelectionArgs = {
  projectNameParam?: string;
  sessionId?: string;
  isLoadingProjects: boolean;
  projects: Project[];
  selectedProject: Project | null;
  handleProjectSelect: (project: Project) => void;
  navigate: NavigateFunction;
};

/**
 * URL ↔ 选中项目的同步、默认项目选择，以及 `/switch-project` 的 window 全局实现。
 * 返回 `userSelectedProjectRef` 供外壳其余交互（项目/会话点击、新建向导）复用同一守卫。
 */
export function useAppShellSelection({
  projectNameParam,
  sessionId,
  isLoadingProjects,
  projects,
  selectedProject,
  handleProjectSelect,
  navigate,
}: UseAppShellSelectionArgs) {
  // Guards the URL→selectedProject sync effect against clobbering a project
  // the user just clicked (see the effect's comment for the full race).
  const userSelectedProjectRef = useRef<string | null>(null);

  // Sync URL projectName -> selectedProject for deep links like /p/:projectName.
  // When the URL also carries a session id (/p/.../c/:sessionId or
  // /session/:sessionId) we let useProjectsState own the resolution because
  // it sets BOTH the project and the session in one effect, avoiding a race
  // where this hook would clear the session via handleProjectSelect.
  //
  // The `userSelectedProjectRef` guard below exists because sidebar clicks
  // update selectedProject synchronously while React Router's navigate()
  // lands later (startTransition), and handleProjectSelect also bumps the
  // `projects` array (setProjects(map(...))), which re-runs this effect
  // before the URL has caught up. Without the guard the effect sees the
  // stale URL (previous project) paired with the freshly selected project,
  // mistakes it for an unsynced deep link, and calls handleProjectSelect
  // back to the previous project — so clicking a project folder appears to
  // do nothing.
  useEffect(() => {
    if (!projectNameParam) return;
    if (sessionId) return;
    // URL caught up with the user's click — release the guard.
    if (userSelectedProjectRef.current !== null && userSelectedProjectRef.current === projectNameParam) {
      userSelectedProjectRef.current = null;
    }
    if (selectedProject?.name === projectNameParam) return;
    // The selected project came from an explicit user click whose URL
    // navigation is still in flight — don't yank the selection back.
    if (userSelectedProjectRef.current !== null && userSelectedProjectRef.current === selectedProject?.name) return;
    const target = projects.find(p => p.name === projectNameParam);
    if (target) {
      handleProjectSelect(target);
      // handleProjectSelect unconditionally navigates to '/' — put the URL back.
      navigate(`/p/${encodeURIComponent(projectNameParam)}`, { replace: true });
    }
  }, [projectNameParam, sessionId, selectedProject?.name, projects, handleProjectSelect, navigate]);

  // Default selection: prefer a regular project. General is only the fallback
  // when no regular project exists. Explicit project/session URLs still own
  // selection and are never overridden here.
  const didDefaultProjectRef = useRef(false);
  useEffect(() => {
    if (didDefaultProjectRef.current) return;
    if (isLoadingProjects) return;
    if (selectedProject) {
      didDefaultProjectRef.current = true;
      return;
    }
    if (projectNameParam || sessionId) {
      didDefaultProjectRef.current = true;
      return;
    }
    const target = chooseDefaultProject(projects);
    if (!target) return;
    handleProjectSelect(target);
    navigate(`/p/${encodeURIComponent(target.name)}`, { replace: true });
    didDefaultProjectRef.current = true;
  }, [isLoadingProjects, selectedProject, projectNameParam, sessionId, projects, handleProjectSelect, navigate]);

  // Resolve a project by name (exact match first, then case-insensitive on
  // both the directory name and the user-facing displayName, then a relaxed
  // case-insensitive substring) and select it via the same handler the
  // sidebar uses, so the chat slash command `/switch-project xxx` can hop
  // between projects without a manual click.
  const switchProject = useCallback(
    (projectName: string): boolean => {
      const trimmed = (projectName ?? "").trim();
      if (!trimmed) return false;

      const exact = projects.find(p => p.name === trimmed);
      const ciExact =
        exact ??
        projects.find(
          p =>
            p.name.toLowerCase() === trimmed.toLowerCase() ||
            (p.displayName ?? "").toLowerCase() === trimmed.toLowerCase(),
        );
      const target =
        ciExact ??
        projects.find(
          p =>
            p.name.toLowerCase().includes(trimmed.toLowerCase()) ||
            (p.displayName ?? "").toLowerCase().includes(trimmed.toLowerCase()),
        );
      if (!target) return false;

      handleProjectSelect(target);
      navigate(`/p/${encodeURIComponent(target.name)}`);
      return true;
    },
    [handleProjectSelect, navigate, projects],
  );

  return { userSelectedProjectRef, switchProject };
}

export type AppShellSelection = ReturnType<typeof useAppShellSelection>;
