import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { setSessionCustomTitle } from "../../../lib/customNames";
import {
  getSessionRequestParams,
  isBackgroundTaskSession,
  type Project,
  type ProjectSession,
} from "../../../types/app";
import { api } from "../../../utils/api";

type UseDeleteProjectArgs = {
  refreshProjectsSilently: () => Promise<void>;
  onProjectDelete?: (projectName: string) => void;
};

/**
 * Project deletion (V2): hover-revealed trash button on each row -> confirm
 * dialog -> DELETE /api/projects/:name (force=true)。复用 useProjectsState 的
 * 清理回调，删除当前项目时同步清空选中并重定向。
 */
export function useDeleteProject({ refreshProjectsSilently, onProjectDelete }: UseDeleteProjectArgs) {
  const { t } = useTranslation("common");
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestDeleteProject = useCallback((project: Project) => {
    setDeleteError(null);
    setDeleteTarget(project);
  }, []);

  const cancelDeleteProject = useCallback(() => {
    if (isDeletingProject) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, [isDeletingProject]);

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setIsDeletingProject(true);
    setDeleteError(null);
    try {
      const response = await api.deleteProject(target.name, true);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (HTTP ${response.status})`);
      }
      onProjectDelete?.(target.name);
      await refreshProjectsSilently();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("deleteDialogs.errorDeleteProject"));
    } finally {
      setIsDeletingProject(false);
    }
  }, [deleteTarget, onProjectDelete, refreshProjectsSilently, t]);

  return {
    deleteTarget,
    isDeletingProject,
    deleteError,
    requestDeleteProject,
    cancelDeleteProject,
    confirmDeleteProject,
  };
}

export type DeleteSessionTarget = {
  project: Project;
  session: ProjectSession;
};

type UseDeleteSessionArgs = {
  refreshProjectsSilently: () => Promise<void>;
  onSessionDelete?: (sessionId: string) => void;
  markSessionRead: (sessionId: string) => void;
};

/** Session deletion：确认 → DELETE /api/projects/:name/sessions/:id → 清理未读/自定义名。 */
export function useDeleteSession({ refreshProjectsSilently, onSessionDelete, markSessionRead }: UseDeleteSessionArgs) {
  const { t } = useTranslation("common");
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<DeleteSessionTarget | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);

  const requestDeleteSession = useCallback((project: Project, session: ProjectSession) => {
    setDeleteSessionError(null);
    setDeleteSessionTarget({ project, session });
  }, []);

  const cancelDeleteSession = useCallback(() => {
    if (isDeletingSession) return;
    setDeleteSessionTarget(null);
    setDeleteSessionError(null);
  }, [isDeletingSession]);

  const confirmDeleteSession = useCallback(async () => {
    if (!deleteSessionTarget) return;

    const { project, session } = deleteSessionTarget;
    setIsDeletingSession(true);
    setDeleteSessionError(null);

    try {
      const response = isBackgroundTaskSession(session)
        ? await api.deleteSession(project.name, session.id, getSessionRequestParams(session))
        : await api.deleteSession(project.name, session.id);

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (HTTP ${response.status})`);
      }

      onSessionDelete?.(session.id);
      markSessionRead(session.id);
      setSessionCustomTitle(session.id, null);
      await refreshProjectsSilently();
      setDeleteSessionTarget(null);
    } catch (err) {
      setDeleteSessionError(err instanceof Error ? err.message : t("deleteDialogs.errorDeleteSession"));
    } finally {
      setIsDeletingSession(false);
    }
  }, [deleteSessionTarget, markSessionRead, onSessionDelete, refreshProjectsSilently, t]);

  return {
    deleteSessionTarget,
    isDeletingSession,
    deleteSessionError,
    requestDeleteSession,
    cancelDeleteSession,
    confirmDeleteSession,
  };
}

export type DeleteProjectState = ReturnType<typeof useDeleteProject>;
export type DeleteSessionState = ReturnType<typeof useDeleteSession>;
