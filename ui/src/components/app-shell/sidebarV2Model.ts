import type { TFunction } from "i18next";
import type { Project, ProjectSession } from "../../types/app";
import { sessionDisplayTitle } from "../../lib/customNames";

export const asTimestamp = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

export const latestTimestamp = (...values: unknown[]): number => Math.max(...values.map(asTimestamp));

export const sessionLastActivity = (session: ProjectSession): number =>
  latestTimestamp(session.lastActivity, session.updated_at, session.createdAt, session.created_at);

export type ProjectSortOrder = "name" | "date";

// The Settings dialog persists `projectSortOrder` into the same
// `sati-settings` localStorage blob the chat surface uses. Up to
// this point nothing on the sidebar consumed it, so the dropdown
// changed nothing. We read it here and re-render whenever the Settings
// tab broadcasts a `sati-settings-changed` event.
export const readProjectSortOrder = (): ProjectSortOrder => {
  if (typeof window === "undefined") return "name";
  const raw = window.localStorage.getItem("sati-settings");
  if (!raw) return "name";
  try {
    const parsed = JSON.parse(raw) as { projectSortOrder?: unknown };
    return parsed.projectSortOrder === "date" ? "date" : "name";
  } catch {
    // 本地设置损坏/非 JSON → 回退默认排序 name。
    return "name";
  }
};

// "Most recent activity" for a project = the project summary timestamp when
// available, or the newest timestamp across previewed sessions. The summary
// matters because the sidebar only keeps a capped session preview.
export const projectLastActivity = (project: Project): number => {
  let latest = latestTimestamp(project.lastActivity, project.updated_at, project.createdAt, project.created_at);
  const sessions = Array.isArray(project.sessions) ? project.sessions : [];
  for (const session of sessions) {
    const ts = sessionLastActivity(session);
    if (ts > latest) latest = ts;
  }
  return latest;
};

export type FlatSession = {
  session: ProjectSession;
  sessionId: string;
  lastActivity: number;
};

export type SessionTreeNode = {
  flat: FlatSession;
  children: SessionTreeNode[];
};

/** 收起状态下列出的会话行上限（展开时最多渲染 500 条）。 */
export const COLLAPSED_SESSION_LIMIT = 5;

export type SessionTreeCacheEntry = {
  allSessions: FlatSession[];
  tree: SessionTreeNode[];
  collapsedTree: SessionTreeNode[];
  titles: Map<string, string>;
};

export const isForkChildSession = (session: ProjectSession, knownSessionIds: Set<string>): boolean =>
  Boolean(
    session.parentSessionId &&
      session.sessionKind !== "background_task" &&
      knownSessionIds.has(session.parentSessionId),
  );

export const buildSessionTree = (flatSessions: FlatSession[]): SessionTreeNode[] => {
  const knownSessionIds = new Set(flatSessions.map(item => item.sessionId));
  const childrenByParent = new Map<string, FlatSession[]>();
  const roots: FlatSession[] = [];

  for (const item of flatSessions) {
    if (isForkChildSession(item.session, knownSessionIds)) {
      const parentId = item.session.parentSessionId as string;
      const list = childrenByParent.get(parentId) ?? [];
      list.push(item);
      childrenByParent.set(parentId, list);
    } else {
      roots.push(item);
    }
  }

  const toNode = (flat: FlatSession): SessionTreeNode => ({
    flat,
    children: (childrenByParent.get(flat.sessionId) ?? [])
      .sort((left, right) => right.lastActivity - left.lastActivity)
      .map(toNode),
  });

  return roots.sort((left, right) => right.lastActivity - left.lastActivity).map(toNode);
};

export const collectSessionsForProject = (project: Project): FlatSession[] => {
  const sessions = Array.isArray(project.sessions) ? project.sessions : [];
  return sessions
    .map(session => ({
      session,
      sessionId: session.id,
      lastActivity: sessionLastActivity(session),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity);
};

export const formatRelative = (ts: number, t: TFunction): string => {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("sidebar:time.justNow", { defaultValue: "just now" });
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    if (minutes === 1) return t("sidebar:time.oneMinuteAgo", { defaultValue: "1 min ago" });
    return t("sidebar:time.minutesAgo", { count: minutes, defaultValue: `${minutes} mins ago` });
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    if (hours === 1) return t("sidebar:time.oneHourAgo", { defaultValue: "1 hour ago" });
    return t("sidebar:time.hoursAgo", { count: hours, defaultValue: `${hours} hours ago` });
  }
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return t("sidebar:time.oneDayAgo", { defaultValue: "1 day ago" });
  return t("sidebar:time.daysAgo", { count: days, defaultValue: `${days} days ago` });
};

export type SessionIndicatorStatus = "processing" | "unread" | "idle";

export const resolveIndicatorStatus = (
  sessionId: string,
  isOptimisticRow: boolean,
  processingSessions: Set<string> | undefined,
  unreadSessionIds: Set<string> | undefined,
): SessionIndicatorStatus => {
  if (isOptimisticRow || processingSessions?.has(sessionId)) return "processing";
  if (unreadSessionIds?.has(sessionId)) return "unread";
  return "idle";
};

export const indicatorStatusLabel = (status: SessionIndicatorStatus, t: TFunction): string => {
  if (status === "processing") return t("sidebar:sessions.processing", { defaultValue: "Agent is running" });
  if (status === "unread") return t("sidebar:sessions.unread", { defaultValue: "Unread messages" });
  return t("sidebar:sessions.idle", { defaultValue: "No unread messages" });
};

export const buildSessionTreeCache = (projects: Project[]): Map<string, SessionTreeCacheEntry> => {
  const cache = new Map<string, SessionTreeCacheEntry>();
  for (const project of projects) {
    const allSessions = collectSessionsForProject(project).slice(0, 500);
    const titles = new Map(allSessions.map(({ sessionId, session }) => [sessionId, sessionDisplayTitle(session)]));
    cache.set(project.name, {
      allSessions,
      tree: buildSessionTree(allSessions),
      collapsedTree: buildSessionTree(allSessions.slice(0, COLLAPSED_SESSION_LIMIT)),
      titles,
    });
  }
  return cache;
};
