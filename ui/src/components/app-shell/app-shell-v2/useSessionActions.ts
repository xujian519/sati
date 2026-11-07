import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { AppTab, Project, ProjectSession } from "../../../types/app";
import type { SessionNavigationOptions } from "../../main-content/types/types";

type UseSessionActionsArgs = {
  navigate: NavigateFunction;
  projects: Project[];
  selectedProject: Project | null;
  userSelectedProjectRef: MutableRefObject<string | null>;
  handleProjectSelect: (project: Project) => void;
  handleSessionSelect: (session: ProjectSession) => void;
  handleNewSession: (project: Project) => void;
  replaceTemporarySession: (realSessionId?: string | null) => void;
  markSessionAsInactive: (sessionId?: string | null) => void;
  replaceOptimisticInProjects: (realSessionId: string) => void;
  dropOptimisticInProjects: (sessionId: string) => void;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  setSelectedProject: Dispatch<SetStateAction<Project | null>>;
  setSelectedSession: Dispatch<SetStateAction<ProjectSession | null>>;
  markSessionRead: (sessionId: string) => void;
};

/** 侧栏/主区的选择与会话生命周期动作，保持 URL 与选中状态一致。 */
export function useSessionActions({
  navigate,
  projects,
  selectedProject,
  userSelectedProjectRef,
  handleProjectSelect,
  handleSessionSelect,
  handleNewSession,
  replaceTemporarySession,
  markSessionAsInactive,
  replaceOptimisticInProjects,
  dropOptimisticInProjects,
  setActiveTab,
  setSelectedProject,
  setSelectedSession,
  markSessionRead,
}: UseSessionActionsArgs) {
  const handleSelectProject = useCallback(
    (project: Project) => {
      // Record the user-initiated selection so the URL sync effect knows
      // this project is being navigated to and must not be yanked back
      // while React Router's navigate() is still in flight.
      userSelectedProjectRef.current = project.name;
      handleProjectSelect(project);
      navigate(`/p/${encodeURIComponent(project.name)}`);
    },
    [handleProjectSelect, navigate, userSelectedProjectRef],
  );

  const handleSelectSession = useCallback(
    (project: Project, sessId: string, fallbackSession?: ProjectSession, options?: SessionNavigationOptions) => {
      markSessionRead(sessId);
      if (project.name !== selectedProject?.name) {
        userSelectedProjectRef.current = project.name;
        handleProjectSelect(project);
      }
      const target = (project.sessions ?? []).find(s => s.id === sessId);
      if (target) {
        handleSessionSelect(fallbackSession ? { ...target, ...fallbackSession } : target);
      } else if (fallbackSession) {
        handleSessionSelect(fallbackSession);
      } else {
        navigate(`/session/${sessId}`);
      }
      if (!options?.preserveActiveTab) {
        setActiveTab("chat");
      }
    },
    [
      handleProjectSelect,
      handleSessionSelect,
      markSessionRead,
      navigate,
      selectedProject?.name,
      setActiveTab,
      userSelectedProjectRef,
    ],
  );

  const handleSelectTab = useCallback(
    (tab: AppTab) => {
      // `home` is retained only for old persisted state / links. The Agent
      // surface now owns both the welcome/new-session state and transcripts.
      if (tab === "home") {
        setSelectedSession(null);
        const target = selectedProject ? `/p/${encodeURIComponent(selectedProject.name)}` : "/";
        if (window.location.pathname !== target) {
          navigate(target);
        }
        setActiveTab("chat");
        return;
      }
      setActiveTab(tab);
    },
    [navigate, selectedProject, setActiveTab, setSelectedSession],
  );

  const handleStartNewSession = useCallback(
    (project: Project | null, options?: SessionNavigationOptions) => {
      if (project) {
        // Same guard as handleSelectProject: handleNewSession switches the
        // selected project while React Router's navigate is still in flight.
        userSelectedProjectRef.current = project.name;
        handleNewSession(project);
        navigate(`/p/${encodeURIComponent(project.name)}`);
        setActiveTab(options?.preserveActiveTab ? "files" : "chat");
      } else if (selectedProject) {
        handleNewSession(selectedProject);
        setActiveTab(options?.preserveActiveTab ? "files" : "chat");
      } else {
        // No project context yet — land on /, MainContent's empty state
        // will prompt the user to create or pick a project.
        navigate("/");
      }
    },
    [handleNewSession, navigate, selectedProject, setActiveTab, userSelectedProjectRef],
  );

  const handleNavigateToSession = useCallback(
    (sid: string) => {
      setSelectedSession(prev => (prev?.id === sid ? prev : ({ id: sid } as ProjectSession)));
      navigate(`/session/${sid}`);
    },
    [navigate, setSelectedSession],
  );

  const handleSelectProjectByName = useCallback(
    (name: string) => {
      const target = projects.find(p => p.name === name);
      if (target) {
        userSelectedProjectRef.current = target.name;
        setSelectedProject(target);
        setSelectedSession(null);
        setActiveTab("dashboard");
        navigate(`/p/${encodeURIComponent(target.name)}`);
      }
    },
    [navigate, projects, setActiveTab, setSelectedProject, setSelectedSession, userSelectedProjectRef],
  );

  // Wrap the two session-lifecycle callbacks coming out of useSessionProtection
  // so they also reconcile the optimistic placeholder rows in the sidebar:
  //  · `session_created` → swap `new-session-*` in projects.sessions for the
  //    real id in-place (no flicker).
  //  · `complete` / `error` → drop any leftover `new-session-*` placeholder
  //    that was never replaced (agent never emitted session_created).
  const handleReplaceTemporarySession = useCallback(
    (realSessionId?: string | null) => {
      replaceTemporarySession(realSessionId);
      if (realSessionId) replaceOptimisticInProjects(realSessionId);
    },
    [replaceTemporarySession, replaceOptimisticInProjects],
  );

  const handleSessionInactive = useCallback(
    (sessionId?: string | null) => {
      markSessionAsInactive(sessionId);
      if (sessionId) dropOptimisticInProjects(sessionId);
    },
    [markSessionAsInactive, dropOptimisticInProjects],
  );

  return {
    handleSelectProject,
    handleSelectSession,
    handleSelectTab,
    handleStartNewSession,
    handleNavigateToSession,
    handleSelectProjectByName,
    handleReplaceTemporarySession,
    handleSessionInactive,
  };
}

export type SessionActions = ReturnType<typeof useSessionActions>;
