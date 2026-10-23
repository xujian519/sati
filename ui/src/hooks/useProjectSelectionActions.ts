import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { AppTab, Project, ProjectSession } from "../types/app";
import { api } from "../utils/api";
import { logError } from "../utils/logging";
import { getProjectSessions, normalizeSessionId, resetProjectSessionPreview } from "./projectSessionUtils";

const SESSION_PAGE_SIZE = 30;

type UseProjectSelectionActionsArgs = {
  sessionId?: string;
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setSelectedProject: Dispatch<SetStateAction<Project | null>>;
  setSelectedSession: Dispatch<SetStateAction<ProjectSession | null>>;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  projectsRef: MutableRefObject<Project[]>;
  navigate: NavigateFunction;
  isMobile: boolean;
  activeTab: AppTab;
};

export function useProjectSelectionActions({
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
}: UseProjectSelectionActionsArgs) {
  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    for (const project of projects) {
      const session = project.sessions?.find(s => s.id === sessionId);
      if (session) {
        if (selectedProject?.name !== project.name) {
          setSelectedProject(project);
        }
        if (selectedSession?.id !== sessionId) {
          setSelectedSession(session);
        }
        return;
      }
    }
  }, [sessionId, projects, selectedProject?.name, selectedSession?.id, setSelectedProject, setSelectedSession]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      const previewProject = resetProjectSessionPreview(project);
      setSelectedProject(previewProject);
      setSelectedSession(null);
      setProjects(prevProjects => prevProjects.map(resetProjectSessionPreview));
      navigate("/");

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate, setProjects, setSelectedProject, setSelectedSession, setSidebarOpen],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      setSelectedSession(session);

      if (activeTab === "tasks" || activeTab === "preview") {
        setActiveTab("chat");
      }

      if (isMobile) {
        const sessionProjectName = session.__projectName;
        const currentProjectName = selectedProject?.name;

        if (sessionProjectName !== currentProjectName) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [activeTab, isMobile, navigate, selectedProject?.name, setActiveTab, setSelectedSession, setSidebarOpen],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab("chat");
      navigate("/");

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate, setActiveTab, setSelectedProject, setSelectedSession, setSidebarOpen],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate("/");
      }

      setProjects(prevProjects =>
        prevProjects.map(project => {
          const hadSession = getProjectSessions(project).some(session => session.id === sessionIdToDelete);

          return {
            ...project,
            sessions: getProjectSessions(project).filter(session => session.id !== sessionIdToDelete),
            sessionMeta: {
              ...project.sessionMeta,
              total: hadSession ? Math.max(0, (project.sessionMeta?.total ?? 0) - 1) : project.sessionMeta?.total,
            },
          };
        }),
      );
    },
    [navigate, selectedSession?.id, setProjects, setSelectedSession],
  );

  // The /api/projects payload caps each project's sessions array at 5 for a
  // snappy first paint. Sidebar exposes a "Load more" affordance backed by
  // this action: it pages through /api/projects/:name/sessions?limit=&offset=
  // names so the button can render a loading state and reject re-entrancy.
  const loadingMoreSessionsRef = useRef<Set<string>>(new Set());
  const [loadingMoreProjectIds, setLoadingMoreProjectIds] = useState<Set<string>>(new Set());

  const setProjectLoading = useCallback((projectName: string, loading: boolean) => {
    if (loading) loadingMoreSessionsRef.current.add(projectName);
    else loadingMoreSessionsRef.current.delete(projectName);
    setLoadingMoreProjectIds(new Set(loadingMoreSessionsRef.current));
  }, []);

  const loadMoreSessions = useCallback(
    async (projectName: string) => {
      if (!projectName) return;
      if (loadingMoreSessionsRef.current.has(projectName)) return;

      const project = projectsRef.current.find(p => p.name === projectName);
      if (!project) return;
      if (project.sessionMeta?.hasMore === false) return;

      const offset = getProjectSessions(project).length;
      setProjectLoading(projectName, true);

      try {
        const response = await api.sessions(projectName, SESSION_PAGE_SIZE, offset);
        if (!response.ok) {
          throw new Error(`Failed to load sessions: ${response.status}`);
        }
        const data = (await response.json()) as {
          sessions?: ProjectSession[];
          hasMore?: boolean;
          total?: number;
        };
        const incoming = Array.isArray(data.sessions) ? data.sessions : [];

        const mergeSessions = (existing: ProjectSession[]): ProjectSession[] => {
          const seen = new Set(existing.map(s => normalizeSessionId(s.id)));
          const merged = [...existing];
          for (const session of incoming) {
            if (!session?.id || seen.has(normalizeSessionId(session.id))) continue;
            seen.add(normalizeSessionId(session.id));
            merged.push(session);
          }
          return merged;
        };

        const applyToProject = (target: Project): Project => ({
          ...target,
          sessions: mergeSessions(target.sessions ?? []),
          sessionMeta: {
            ...(target.sessionMeta ?? {}),
            hasMore: Boolean(data.hasMore),
            total: typeof data.total === "number" ? data.total : target.sessionMeta?.total,
          },
        });

        setProjects(prevProjects => prevProjects.map(p => (p.name === projectName ? applyToProject(p) : p)));

        setSelectedProject(prev => (prev && prev.name === projectName ? applyToProject(prev) : prev));
      } catch (error) {
        logError("loadMoreSessions failed for project", projectName, error);
      } finally {
        setProjectLoading(projectName, false);
      }
    },
    [projectsRef, setProjectLoading, setProjects, setSelectedProject],
  );

  const handleProjectDelete = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate("/");
      }

      setProjects(prevProjects => prevProjects.filter(project => project.name !== projectName));
    },
    [navigate, selectedProject?.name, setProjects, setSelectedProject, setSelectedSession],
  );

  const handleDeselectProject = useCallback(() => {
    setSelectedProject(null);
    setSelectedSession(null);
    setProjects(prevProjects => prevProjects.map(resetProjectSessionPreview));
    navigate("/");
  }, [navigate, setProjects, setSelectedProject, setSelectedSession]);

  return {
    loadingMoreProjectIds,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleDeselectProject,
    loadMoreSessions,
  };
}
