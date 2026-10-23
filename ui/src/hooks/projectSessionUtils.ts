import type { Project, ProjectSession } from "../types/app";

const PROJECT_SESSION_PREVIEW_LIMIT = 5;

export const getProjectSessions = (project: Project): ProjectSession[] => project.sessions ?? [];

// Local-only placeholders we prepend to a project's session list the moment
// the user submits a new-session message, so the sidebar reflects it without
// waiting for the server's debounced `projects_updated` round-trip. They are
// carried forward across `projects_updated` events (so an unrelated update
// fired between submit and chokidar can't flicker them away) and replaced
// in-place via `replaceOptimisticInProjects` once the real id arrives via
// `session_created`, or dropped via `dropOptimisticInProjects` on
// completion/abort if no real id was ever assigned.
export const isTemporarySessionId = (id: unknown): boolean => typeof id === "string" && id.startsWith("new-session-");

// On Windows, session keys like `web:s_<uuid>` are sanitized to `web-s_<uuid>`
// for disk storage. Normalize to the disk form so that in-memory state
// (from session_created) matches server listings (from filenames).
export const normalizeSessionId = (id: string): string => id.replace(/^web:s_/, "web-s_");

export const resetProjectSessionPreview = (project: Project): Project => {
  const sessions = project.sessions ?? [];
  if (sessions.length <= PROJECT_SESSION_PREVIEW_LIMIT) {
    return project;
  }

  const total = typeof project.sessionMeta?.total === "number" ? project.sessionMeta.total : sessions.length;

  return {
    ...project,
    sessions: sessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT),
    sessionMeta: {
      ...(project.sessionMeta ?? {}),
      total,
      hasMore: total > PROJECT_SESSION_PREVIEW_LIMIT,
    },
  };
};
