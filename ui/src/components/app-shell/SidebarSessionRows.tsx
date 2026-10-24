import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { GitBranch } from "lucide-react";
import type { AppTab, Project, ProjectSession } from "../../types/app";
import { cn } from "../../lib/utils.js";
import { sessionDisplayTitle } from "../../lib/customNames";
import {
  buildSessionTree,
  COLLAPSED_SESSION_LIMIT,
  collectSessionsForProject,
  formatRelative,
  indicatorStatusLabel,
  resolveIndicatorStatus,
  type SessionTreeCacheEntry,
  type SessionTreeNode,
} from "./sidebarV2Model";
import SidebarSessionStatusIndicator from "./SidebarSessionStatusIndicator";

export type SidebarSessionRowsProps = {
  project: Project;
  flat?: boolean;
  sessionTreeByProject: Map<string, SessionTreeCacheEntry>;
  collapsedSessionProjects: Set<string>;
  setCollapsedSessionProjects: (updater: (previous: Set<string>) => Set<string>) => void;
  draftSessionProjectName: string | null;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  processingSessions?: Set<string>;
  unreadSessionIds?: Set<string>;
  loadingMoreProjectIds?: Set<string>;
  renamingSession: string | null;
  renameDraft: string;
  setRenameDraft: (value: string) => void;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  commitSessionRename: () => void;
  handleRenameKey: (event: React.KeyboardEvent<HTMLInputElement>, kind: "project" | "session") => void;
  onLoadMoreSessions?: (projectName: string) => void;
  handleSessionClick: (project: Project, sessionId: string) => void;
  handleNewSession: (event: React.MouseEvent, project: Project) => void;
  openSessionContextMenu: (event: React.MouseEvent, project: Project, session: ProjectSession) => void;
  t: TFunction;
};

/**
 * 单个项目的会话行（#646 B3.1）：从 SidebarV2.renderSessionRows 原样外置。
 * fork 子级缩进、乐观占位行、折叠/展开与加载更多全部保留原表达式。
 */
export default function SidebarSessionRows({
  project,
  flat = false,
  sessionTreeByProject,
  collapsedSessionProjects,
  setCollapsedSessionProjects,
  draftSessionProjectName,
  selectedProject,
  selectedSession,
  activeTab,
  processingSessions,
  unreadSessionIds,
  loadingMoreProjectIds,
  renamingSession,
  renameDraft,
  setRenameDraft,
  renameInputRef,
  commitSessionRename,
  handleRenameKey,
  onLoadMoreSessions,
  handleSessionClick,
  handleNewSession,
  openSessionContextMenu,
  t,
}: SidebarSessionRowsProps) {
  const cached = sessionTreeByProject.get(project.name);
  const allSessions = cached?.allSessions ?? collectSessionsForProject(project).slice(0, 500);
  const isCollapsed = collapsedSessionProjects.has(project.name);
  const sessions = isCollapsed ? allSessions.slice(0, COLLAPSED_SESSION_LIMIT) : allSessions;
  const hiddenLoadedCount = isCollapsed ? Math.max(0, allSessions.length - COLLAPSED_SESSION_LIMIT) : 0;
  // If `useProjectsState.bumpSessionActivity` has prepended an optimistic
  // `new-session-*` placeholder for this project, suppress the legacy
  // "+ New Session — not saved yet" draft button so we don't show two
  // stacked rows for the same in-flight session.
  const hasOptimisticSession = allSessions.some(
    ({ session }) => typeof session.id === "string" && session.id.startsWith("new-session-"),
  );
  const showDraftSession =
    draftSessionProjectName === project.name &&
    selectedProject?.name === project.name &&
    activeTab === "chat" &&
    !selectedSession &&
    !hasOptimisticSession;
  const hasMoreSessions = Boolean(project.sessionMeta?.hasMore);
  const isLoadingMore = Boolean(loadingMoreProjectIds?.has(project.name));
  const totalSessions = typeof project.sessionMeta?.total === "number" ? project.sessionMeta.total : null;
  const remaining = totalSessions !== null ? Math.max(0, totalSessions - allSessions.length) : null;
  const totalMore = hiddenLoadedCount + (remaining !== null && remaining > 0 ? remaining : 0);

  // `flat` mode is used by the General tab where sessions are rendered as a
  // top-level list (no folder ancestor), so the usual ml-6 indent would
  // leave a weird empty gutter on the left.
  const containerClass = flat ? "space-y-0.5" : "ml-6 space-y-0.5";
  const sessionTree = isCollapsed
    ? (cached?.collapsedTree ?? buildSessionTree(sessions))
    : (cached?.tree ?? buildSessionTree(sessions));
  const sessionTitleById =
    cached?.titles ?? new Map(allSessions.map(({ sessionId, session }) => [sessionId, sessionDisplayTitle(session)]));
  // 注：titles 来自 useMemo 缓存（随 projects 刷新重建），仅用于 fork 父级
  // 标签（renderSessionTreeNode 的 parentTitle）；用户重命名父会话后该标签
  // 最迟下一次 projects 刷新时更新，主行标题不受影响（渲染时实时计算）。

  const renderSessionTreeNode = (node: SessionTreeNode, depth: number, isForkChild: boolean): ReactNode => {
    const { session, sessionId, lastActivity } = node.flat;
    const isSessionActive =
      selectedProject?.name === project.name && selectedSession?.id === sessionId && activeTab === "chat";
    const isSessionRenaming = renamingSession === sessionId;
    const isOptimisticRow = typeof sessionId === "string" && sessionId.startsWith("new-session-");
    const indicatorStatus = resolveIndicatorStatus(sessionId, isOptimisticRow, processingSessions, unreadSessionIds);
    const indicatorLabel = indicatorStatusLabel(indicatorStatus, t);
    const parentTitle = session.parentSessionId ? sessionTitleById.get(session.parentSessionId) : undefined;

    return (
      <div
        key={sessionId}
        className={depth > 0 ? "ml-4 border-l border-neutral-200 pl-2 dark:border-neutral-800" : undefined}
      >
        <div
          onContextMenu={event => (isOptimisticRow ? undefined : openSessionContextMenu(event, project, session))}
          className={cn(
            "group/session relative w-full rounded-md transition-colors",
            isSessionActive
              ? "bg-gradient-to-r from-brand-50 to-brand-50/60 shadow-xs ring-1 ring-brand-200/60 dark:from-brand-900/30 dark:to-brand-900/10 dark:ring-brand-700/30"
              : "hover:bg-neutral-100/80 dark:hover:bg-neutral-800/70",
          )}
        >
          {isSessionRenaming ? (
            <div className="flex items-center px-2 py-1">
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={event => setRenameDraft(event.target.value)}
                onBlur={commitSessionRename}
                onKeyDown={event => handleRenameKey(event, "session")}
                onClick={event => event.stopPropagation()}
                placeholder={t("sidebar:renamePlaceholder", { defaultValue: "Rename - empty to reset" }) as string}
                className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-hidden focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={isOptimisticRow ? undefined : () => handleSessionClick(project, sessionId)}
              disabled={isOptimisticRow}
              className={cn("flex w-full items-start gap-2 px-2 py-1 text-left", isOptimisticRow && "cursor-default")}
            >
              <span className="flex h-[18px] w-3 shrink-0 items-center justify-center pt-[3px]">
                <SidebarSessionStatusIndicator status={indicatorStatus} label={indicatorLabel} />
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-1 truncate text-[12.5px] text-neutral-900 dark:text-neutral-100",
                    isOptimisticRow && "text-neutral-600 italic dark:text-neutral-300",
                  )}
                >
                  {isForkChild ? (
                    <GitBranch className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={2} />
                  ) : null}
                  <span className="truncate">{sessionDisplayTitle(session)}</span>
                </div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {isOptimisticRow
                    ? t("sidebar:sessions.sending", { defaultValue: "Sending…" })
                    : isForkChild
                      ? t("sidebar:sessions.forkedFrom", {
                          parent: parentTitle || session.parentSessionId || "",
                          defaultValue: `forked from ${parentTitle || session.parentSessionId || "parent"}`,
                        })
                      : formatRelative(lastActivity, t)}
                </div>
              </div>
            </button>
          )}
        </div>
        {node.children.length > 0 ? (
          <div className="mt-0.5 space-y-0.5">
            {node.children.map(child => renderSessionTreeNode(child, depth + 1, true))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={containerClass}>
      {showDraftSession ? (
        <button
          type="button"
          onClick={event => handleNewSession(event, project)}
          className="block w-full rounded-md bg-brand-50 px-2 py-1 text-left text-neutral-900 dark:bg-brand-900/20 dark:text-neutral-100"
        >
          <div className="truncate text-[12.5px]">
            {t("sidebar:sessions.newSession", { defaultValue: "New Session" })}
          </div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {t("sidebar:sessions.unsaved", { defaultValue: "Not saved yet" })}
          </div>
        </button>
      ) : null}

      {sessionTree.length > 0 ? (
        sessionTree.map(node => renderSessionTreeNode(node, 0, false))
      ) : (
        <div className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {t("sidebar:sessions.noSessions", { defaultValue: "No sessions yet" })}
        </div>
      )}

      {(isCollapsed && hiddenLoadedCount > 0) || (!isCollapsed && hasMoreSessions && onLoadMoreSessions) ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            if (isLoadingMore) return;
            if (isCollapsed) {
              setCollapsedSessionProjects(prev => {
                const next = new Set(prev);
                next.delete(project.name);
                return next;
              });
            } else if (onLoadMoreSessions) {
              onLoadMoreSessions(project.name);
            }
          }}
          disabled={isLoadingMore}
          className={cn(
            "block w-full rounded-md px-2 py-1 text-left text-[11px] transition-colors",
            isLoadingMore
              ? "text-neutral-400 dark:text-neutral-500"
              : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200",
          )}
        >
          {isLoadingMore
            ? t("sidebar:sessions.loadingMore", { defaultValue: "Loading more…" })
            : totalMore > 0
              ? t("sidebar:sessions.showMoreCount", {
                  count: totalMore,
                  defaultValue: `Show more (${totalMore})`,
                })
              : t("sidebar:sessions.showMore", { defaultValue: "Show more sessions" })}
        </button>
      ) : null}

      {!isCollapsed && allSessions.length > COLLAPSED_SESSION_LIMIT ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            setCollapsedSessionProjects(prev => {
              const next = new Set(prev);
              next.add(project.name);
              return next;
            });
          }}
          className="block w-full rounded-md px-2 py-1 text-left text-[11px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          {t("sidebar:sessions.showLess", { defaultValue: "Show less" })}
        </button>
      ) : null}
    </div>
  );
}
