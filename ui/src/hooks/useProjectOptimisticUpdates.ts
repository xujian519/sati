import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Project, ProjectSession } from "../types/app";
import { isTemporarySessionId, resetProjectSessionPreview } from "./projectSessionUtils";

type UseProjectOptimisticUpdatesArgs = {
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setSelectedProject: Dispatch<SetStateAction<Project | null>>;
};

export function useProjectOptimisticUpdates({ setProjects, setSelectedProject }: UseProjectOptimisticUpdatesArgs) {
  // Shared idiom for the optimistic sidebar transforms below: apply the same
  // per-project map to the project list and to the selected project. `apply`
  // must be idempotent per project and return the same reference when the
  // project is untouched so unchanged state doesn't re-render.
  const applyProjectTransform = useCallback(
    (apply: (project: Project) => Project) => {
      setProjects(prev => prev.map(apply));
      setSelectedProject(prev => (prev ? apply(prev) : prev));
    },
    [setProjects, setSelectedProject],
  );

  // Optimistic sidebar update for the moment a user submits a message.
  // We do NOT wait for the server's chokidar-debounced `projects_updated`
  // round-trip — instead we either bump the existing session's lastActivity
  // (so "sort by date" reorders immediately) or prepend a placeholder
  // entry for a brand-new session. The placeholder uses a `new-session-*`
  // id and is filtered out automatically the next time `preserveLoadedSessions`
  // runs against a server payload.
  const bumpSessionActivity = useCallback(
    (projectName: string, sessionId: string, optimisticTitle?: string) => {
      if (!projectName || !sessionId) return;
      const now = new Date().toISOString();

      const apply = (project: Project): Project => {
        if (project.name !== projectName) return project;
        const sessions = project.sessions ?? [];
        const idx = sessions.findIndex(s => s.id === sessionId);

        if (idx >= 0) {
          const bumped: ProjectSession = {
            ...sessions[idx],
            updated_at: now,
            lastActivity: now,
          };
          const reordered = [bumped, ...sessions.slice(0, idx), ...sessions.slice(idx + 1)];
          return { ...project, lastActivity: now, sessions: reordered };
        }

        const trimmedTitle = (optimisticTitle ?? "").replace(/\s+/g, " ").trim();
        const placeholder: ProjectSession = {
          id: sessionId,
          title: trimmedTitle ? trimmedTitle.slice(0, 80) : "New session",
          created_at: now,
          updated_at: now,
          lastActivity: now,
          messageCount: 0,
          __projectName: projectName,
        };
        return {
          ...project,
          lastActivity: now,
          sessions: [placeholder, ...sessions],
          sessionMeta: {
            ...(project.sessionMeta ?? {}),
            total:
              typeof project.sessionMeta?.total === "number"
                ? project.sessionMeta.total + 1
                : project.sessionMeta?.total,
          },
        };
      };

      applyProjectTransform(apply);
    },
    [applyProjectTransform],
  );

  // Swap a `new-session-*` placeholder for the real id the server just
  // assigned (fired on `session_created`). We replace in-place so the row
  // doesn't flicker, and dedupe if `projects_updated` already brought the
  // real session in.
  const replaceOptimisticInProjects = useCallback(
    (realSessionId: string) => {
      if (!realSessionId || isTemporarySessionId(realSessionId)) return;
      const apply = (project: Project): Project => {
        const sessions = project.sessions ?? [];
        const tempIdx = sessions.findIndex(s => isTemporarySessionId(s.id));
        if (tempIdx < 0) return project;
        const realExists = sessions.some(s => s.id === realSessionId);
        if (realExists) {
          return {
            ...project,
            sessions: sessions.filter(s => !isTemporarySessionId(s.id)),
          };
        }
        const replaced: ProjectSession = { ...sessions[tempIdx], id: realSessionId };
        return {
          ...project,
          sessions: sessions.map((s, i) => (i === tempIdx ? replaced : s)),
        };
      };
      applyProjectTransform(apply);
    },
    [applyProjectTransform],
  );

  // Drop any optimistic placeholders for a given session id. Used when a
  // session goes inactive without ever receiving a real id (errors, aborts
  // before the agent emitted `session_created`).
  const dropOptimisticInProjects = useCallback(
    (sessionId: string) => {
      if (!sessionId || !isTemporarySessionId(sessionId)) return;
      const apply = (project: Project): Project => {
        const sessions = project.sessions ?? [];
        if (!sessions.some(s => s.id === sessionId)) return project;
        return {
          ...project,
          sessions: sessions.filter(s => s.id !== sessionId),
        };
      };
      applyProjectTransform(apply);
    },
    [applyProjectTransform],
  );

  const handleResetProjectSessionPreview = useCallback(
    (projectName: string) => {
      const apply = (project: Project): Project =>
        project.name === projectName ? resetProjectSessionPreview(project) : project;
      applyProjectTransform(apply);
    },
    [applyProjectTransform],
  );

  return {
    bumpSessionActivity,
    replaceOptimisticInProjects,
    dropOptimisticInProjects,
    handleResetProjectSessionPreview,
  };
}
