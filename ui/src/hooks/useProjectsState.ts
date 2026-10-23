import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { logError } from "../utils/logging";
import { api } from "../utils/api";
import type {
  AppSocketMessage,
  AppTab,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
} from "../types/app";
import { isBackgroundTaskSession } from "../types/app";
import { UI_TIMEOUTS } from "../constants/timeouts";
import { getProjectSessions, isTemporarySessionId, normalizeSessionId } from "./projectSessionUtils";
import { useProjectOptimisticUpdates } from "./useProjectOptimisticUpdates";
import { useProjectSelectionActions } from "./useProjectSelectionActions";
import { useProjectSettingsPanel } from "./useProjectSettingsPanel";

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  isMobile: boolean;
  activeSessions: Set<string>;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);

function preserveSelectedSessionViewState(
  updatedSession: ProjectSession,
  selectedSession: ProjectSession,
): ProjectSession {
  const viewState: Partial<ProjectSession> = {};
  const preserveKeys: Array<keyof ProjectSession> = [
    "sessionKind",
    "parentSessionId",
    "relativeTranscriptPath",
    "transcriptKey",
    "taskId",
    "taskStatus",
    "outputFile",
    "isReadOnly",
    "__projectName",
  ];

  for (const key of preserveKeys) {
    if (selectedSession[key] !== undefined) {
      (viewState as Record<string, unknown>)[key] = selectedSession[key];
    }
  }

  return Object.keys(viewState).length > 0 ? { ...updatedSession, ...viewState } : updatedSession;
}

export const projectsHaveChanges = (prevProjects: Project[], nextProjects: Project[]): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    return (
      nextProject.name !== prevProject.name ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      nextProject.lastActivity !== prevProject.lastActivity ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster)
    );
  });
};

const sessionTranscriptFilename = (id: string): string => `${normalizeSessionId(id)}.jsonl`;

export const preserveLoadedSessions = (prevProjects: Project[], nextProjects: Project[]): Project[] =>
  nextProjects.map(updated => {
    const prev = prevProjects.find(p => p.name === updated.name);
    if (!prev) return updated;
    const prevSessions = prev.sessions ?? [];
    const updatedSessions = updated.sessions ?? [];
    const updatedIds = new Set(updatedSessions.map(s => normalizeSessionId(s.id)));
    // Carry forward any in-flight optimistic placeholders (`new-session-*`)
    // that the server payload doesn't yet know about. They're explicitly
    // dropped by `replaceOptimisticInProjects` / `dropOptimisticInProjects`
    // once the real session id arrives. Without this we'd flicker the
    // placeholder away on the first `projects_updated` that happens to fire
    // before the new file shows up in the server's session list (~300ms
    // chokidar debounce vs unbounded agent start latency).
    const optimisticToKeep = prevSessions.filter(
      s => isTemporarySessionId(s.id) && !updatedIds.has(normalizeSessionId(s.id)),
    );
    const prevRealSessions = prevSessions.filter(s => !isTemporarySessionId(s.id));
    if (prevRealSessions.length <= updatedSessions.length) {
      if (optimisticToKeep.length === 0) return updated;
      return {
        ...updated,
        sessions: [...optimisticToKeep, ...updatedSessions],
      };
    }
    const merged = [
      ...optimisticToKeep,
      ...updatedSessions,
      ...prevRealSessions.filter(s => !updatedIds.has(normalizeSessionId(s.id))),
    ];
    return {
      ...updated,
      sessions: merged,
      sessionMeta: {
        ...updated.sessionMeta,
        hasMore: prev.sessionMeta?.hasMore ?? updated.sessionMeta?.hasMore,
        total: prev.sessionMeta?.total ?? updated.sessionMeta?.total,
      },
    };
  });

/**
 * Merge a `projects_updated` payload into local state without spurious
 * reference churn. Returns `prevProjects` when nothing meaningful changed
 * so React can skip re-renders and effects won't re-fire on `projects`.
 */
export function applyProjectsSocketUpdate(prevProjects: Project[], updatedProjects: Project[]): Project[] {
  if (prevProjects.length === 0) {
    return updatedProjects;
  }
  const merged = preserveLoadedSessions(prevProjects, updatedProjects);
  if (!projectsHaveChanges(prevProjects, merged)) {
    return prevProjects;
  }
  return merged;
}

// Shared shape for explicit fetches (initial load / manual refresh): skip the
// update when the raw payload matches current state so references stay stable.
// (Unlike applyProjectsSocketUpdate this checks the raw payload first — keep
// the two orders distinct.)
const mergeFetchedProjects = (prevProjects: Project[], freshProjects: Project[]): Project[] => {
  if (!projectsHaveChanges(prevProjects, freshProjects)) return prevProjects;
  return preserveLoadedSessions(prevProjects, freshProjects);
};

const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find(project => project.name === selectedProject.name);
  const updatedSelectedProject = updatedProjects.find(project => project.name === selectedProject.name);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = getProjectSessions(currentSelectedProject).find(
    session => session.id === selectedSession.id,
  );
  const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
    session => session.id === selectedSession.id,
  );

  if (!currentSelectedSession || !updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

const VALID_TABS: Set<string> = new Set([
  "home",
  "chat",
  "always-on",
  "files",
  "shell",
  "git",
  "tasks",
  "memory",
  "skills",
  "preview",
  "dashboard",
]);

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith("plugin:");
};

const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem("activeTab");
    if (stored === "home") {
      return "chat";
    }
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  return "chat";
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);

  useEffect(() => {
    try {
      localStorage.setItem("activeTab", activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const { showSettings, setShowSettings, settingsInitialTab, openSettings } = useProjectSettingsPanel();
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track when a session was first selected so the projects_updated handler
  const prevTrackedSessionIdRef = useRef<string | null>(null);
  if (selectedSession?.id !== prevTrackedSessionIdRef.current) {
    prevTrackedSessionIdRef.current = selectedSession?.id ?? null;
  }

  // Mirror `projects` into a ref so async callbacks can read the latest list
  // without closing over stale state (e.g. loadMoreSessions early-bail check).
  const projectsRef = useRef<Project[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      if (!Array.isArray(projectData)) {
        logError("Error fetching projects: expected array, got", projectData);
        return;
      }

      setProjects(prevProjects => mergeFetchedProjects(prevProjects, projectData));
    } catch (error) {
      logError("Error fetching projects:", error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    if (latestMessage.type === "loading_progress") {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === "complete") {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, UI_TIMEOUTS.LOADING_PROGRESS_COMPLETE_HOLD_MS);
      }

      return;
    }

    if (latestMessage.type !== "projects_updated") {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;

    if (projectsMessage.changedFile && selectedSession && selectedProject) {
      const normalized = projectsMessage.changedFile.replace(/\\/g, "/");
      const projectPrefix = `${selectedProject.name}/`;
      const projectRelativeChanged = normalized.startsWith(projectPrefix) ? normalized.slice(projectPrefix.length) : "";
      const isSelectedBackgroundTranscriptChange =
        isBackgroundTaskSession(selectedSession) && projectRelativeChanged === selectedSession.relativeTranscriptPath;
      const isMainSessionChange =
        !isBackgroundTaskSession(selectedSession) &&
        projectRelativeChanged === sessionTranscriptFilename(selectedSession.id);

      if (isMainSessionChange || isSelectedBackgroundTranscriptChange) {
        const isSessionActive = activeSessions.has(selectedSession.id);

        if (!isSessionActive) {
          setExternalMessageUpdate(prev => prev + 1);
        }
      }
    }

    const hasActiveSession =
      (selectedSession && activeSessions.has(selectedSession.id)) ||
      (activeSessions.size > 0 && Array.from(activeSessions).some(id => id.startsWith("new-session-")));

    const updatedProjects = projectsMessage.projects;

    // While a session is streaming we must NOT replace `selectedProject` /
    // `selectedSession` mid-flight (the chat pane and downstream hooks key
    // off the session reference and would re-load / re-render unexpectedly).
    // However, we DO still want the sidebar to reflect the new `updated_at`
    // / `lastActivity` for the streaming session — that's the whole point
    // of broadcasting `projects_updated`. The earlier implementation bailed
    // out of the entire handler here, which left the sidebar stale until
    // the user manually refreshed.
    const skipSelectedReplacement =
      hasActiveSession && !isUpdateAdditive(projectsRef.current, updatedProjects, selectedProject, selectedSession);

    setProjects(prevProjects => applyProjectsSocketUpdate(prevProjects, updatedProjects));

    if (skipSelectedReplacement) {
      // Still sync display-only fields (title, summary) so the header
      // title updates immediately when aiTitle is written, without
      // triggering a full chat reload.
      if (selectedProject && selectedSession) {
        const updatedProject = updatedProjects.find(p => p.name === selectedProject.name);
        const updatedSession = updatedProject
          ? getProjectSessions(updatedProject).find(s => s.id === selectedSession.id)
          : undefined;
        if (updatedSession) {
          const displayKeys: Array<keyof ProjectSession> = ["title", "summary", "name"];
          const patch: Partial<ProjectSession> = {};
          for (const key of displayKeys) {
            if (updatedSession[key] !== undefined && updatedSession[key] !== selectedSession[key]) {
              (patch as Record<string, unknown>)[key] = updatedSession[key];
            }
          }
          if (Object.keys(patch).length > 0) {
            setSelectedSession({ ...selectedSession, ...patch });
          }
        }
      }
      return;
    }

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(project => project.name === selectedProject.name);

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      setSelectedProject(updatedSelectedProject);
    }

    if (!selectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      session => session.id === selectedSession.id,
    );

    if (!updatedSelectedSession) {
      // The session is absent from the truncated project list (only the
      // top-N sessions are included in projects_updated for performance).
      // This does NOT mean the session was deleted — it may simply be
      // older than the top-N cut-off, or the file watcher hasn't indexed
      // a brand-new session yet.
      //
      // Never clear selectedSession here. The only paths that should
      // clear it are explicit user actions: switching projects, starting
      // a new session, or deleting the session/project.
      return;
    }

    const normalizedUpdatedSelectedSession = preserveSelectedSessionViewState(updatedSelectedSession, selectedSession);

    if (serialize(normalizedUpdatedSelectedSession) !== serialize(selectedSession)) {
      setSelectedSession(normalizedUpdatedSelectedSession);
    }
  }, [latestMessage, selectedProject, selectedSession, activeSessions]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  const {
    loadingMoreProjectIds,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleDeselectProject,
    loadMoreSessions,
  } = useProjectSelectionActions({
    sessionId,
    projects,
    selectedProject,
    selectedSession,
    setProjects,
    setSelectedProject,
    setSelectedSession,
    setActiveTab,
    setSidebarOpen,
    projectsRef,
    navigate,
    isMobile,
    activeTab,
  });

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];

      setProjects(prevProjects => mergeFetchedProjects(prevProjects, freshProjects));

      if (!selectedProject) {
        return;
      }

      const refreshedProject = freshProjects.find(project => project.name === selectedProject.name);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(session => session.id === selectedSession.id);

      if (refreshedSession) {
        if (serialize(refreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(refreshedSession);
        }
      }
    } catch (error) {
      logError("Error refreshing sidebar:", error);
    }
  }, [selectedProject, selectedSession]);

  const {
    bumpSessionActivity,
    replaceOptimisticInProjects,
    dropOptimisticInProjects,
    handleResetProjectSessionPreview,
  } = useProjectOptimisticUpdates({ setProjects, setSelectedProject });

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      setShowSettings,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    setActiveTab,
    setSelectedSession,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleDeselectProject,
    handleResetProjectSessionPreview,
    setSelectedProject,
    handleSidebarRefresh,
    loadMoreSessions,
    loadingMoreProjectIds,
    bumpSessionActivity,
    replaceOptimisticInProjects,
    dropOptimisticInProjects,
  };
}
