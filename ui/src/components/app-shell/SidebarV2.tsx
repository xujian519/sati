import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AppTab, Project, ProjectSession } from "../../types/app";
import { cn } from "../../lib/utils.js";
import { projectDisplayName, useCustomNamesVersion } from "../../lib/customNames";
import { buildSessionTreeCache, projectLastActivity } from "./sidebarV2Model";
import { useProjectSortOrder } from "./useSidebarProjectSort";
import { useSidebarResize } from "./useSidebarResize";
import { useSidebarRename } from "./useSidebarRename";
import { useSidebarContextMenu } from "./useSidebarContextMenu";
import SidebarHeader from "./SidebarHeader";
import SidebarSectionToggle from "./SidebarSectionToggle";
import SidebarProjectsSection from "./SidebarProjectsSection";
import SidebarGeneralSection from "./SidebarGeneralSection";
import SidebarFooter from "./SidebarFooter";
import SidebarContextMenu from "./SidebarContextMenu";
import SidebarProjectGroup from "./SidebarProjectGroup";
import SidebarSessionRows from "./SidebarSessionRows";

export type SidebarV2Props = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isLoading: boolean;
  processingSessions?: Set<string>;
  unreadSessionIds?: Set<string>;
  onSelectProject: (project: Project) => void;
  onSelectSession: (project: Project, sessionId: string) => void;
  onStartNewSession: (project: Project | null) => void;
  onCreateProject: () => void;
  onRequestDeleteProject: (project: Project) => void;
  onRequestDeleteSession: (project: Project, session: ProjectSession) => void;
  onShowSettings: () => void;
  onOpenTeamPanel?: () => void;
  /** 浮层开态：Team 按钮呈激活色（aria-pressed）。 */
  isTeamPanelOpen?: boolean;
  onDeselectProject?: () => void;
  onResetProjectSessionPreview?: (projectName: string) => void;
  onCollapse?: () => void;
  onLoadMoreSessions?: (projectName: string) => void;
  loadingMoreProjectIds?: Set<string>;
};

export default function SidebarV2({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  isLoading,
  processingSessions,
  unreadSessionIds,
  onSelectProject,
  onSelectSession,
  onStartNewSession,
  onCreateProject,
  onRequestDeleteProject,
  onRequestDeleteSession,
  onShowSettings,
  onOpenTeamPanel,
  isTeamPanelOpen,
  onDeselectProject,
  onResetProjectSessionPreview,
  onCollapse,
  onLoadMoreSessions,
  loadingMoreProjectIds,
}: SidebarV2Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useCustomNamesVersion();
  const safeProjects = useMemo(() => (Array.isArray(projects) ? projects : []), [projects]);

  // 会话树构建缓存：仅在 projects 引用变化时重建。此前每次 shell re-render
  // （流式帧/1.2s 轮询）都会对每个项目重复 collect + sort + buildSessionTree
  // （O(n log n) + O(n)）；缓存后 renderSessionRows 只做廉价的 slice 与读取。
  const sessionTreeByProject = useMemo(() => buildSessionTreeCache(safeProjects), [safeProjects]);

  const { sidebarWidth, isResizing, handleResizeStart, resetSidebarWidth } = useSidebarResize();

  const {
    renamingProject,
    renamingSession,
    renameDraft,
    setRenameDraft,
    renameInputRef,
    beginRenameProject,
    beginRenameSession,
    commitProjectRename,
    commitSessionRename,
    handleRenameKey,
  } = useSidebarRename();

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const { contextMenu, openProjectContextMenu, openSessionContextMenu, closeContextMenu } = useSidebarContextMenu({
    renamingProject,
    renamingSession,
  });
  const [collapsedSessionProjects, setCollapsedSessionProjects] = useState<Set<string>>(new Set());
  const [draftSessionProjectName, setDraftSessionProjectName] = useState<string | null>(null);

  // Segmented toggle between the Projects list and the General workspace.
  // A fresh shell always starts on Projects; explicit project/session routing
  // is synchronized below and still moves the toggle to General when needed.
  type SidebarSection = "projects" | "general";
  const [activeSection, setActiveSection] = useState<SidebarSection>("projects");

  useEffect(() => {
    if (!selectedProject?.name) return;
    setExpandedGroups(previous => {
      if (previous.has(selectedProject.name)) return previous;
      const next = new Set(previous);
      next.add(selectedProject.name);
      return next;
    });
  }, [selectedProject?.name]);

  useEffect(() => {
    if (!draftSessionProjectName) return;
    if (!selectedProject || selectedSession || selectedProject.name !== draftSessionProjectName) {
      setDraftSessionProjectName(null);
    }
  }, [draftSessionProjectName, selectedProject, selectedSession]);

  const generalProject =
    safeProjects.find(project => project.name === "general" || project.displayName === "general") ?? null;

  // Auto-flip the section toggle to match the active project when it changes
  // externally (e.g. /switch-project, deep-linking, default selection on
  // first load). Without this, navigating to a project on one section while
  // the sidebar is parked on the other leaves the new project invisible.
  // We only react to changes — if the user manually clicks the toggle we
  // never fight them mid-session.
  const previousSelectedProjectNameRef = useRef<string | null>(null);
  useEffect(() => {
    const currentName = selectedProject?.name ?? null;
    const previousName = previousSelectedProjectNameRef.current;
    previousSelectedProjectNameRef.current = currentName;
    if (!currentName) return;
    if (currentName === previousName) return;

    const nextSection: SidebarSection = generalProject && currentName === generalProject.name ? "general" : "projects";
    setActiveSection(current => (current === nextSection ? current : nextSection));
  }, [selectedProject?.name, generalProject]);

  const projectSortOrder = useProjectSortOrder();
  const otherProjects = useMemo(() => {
    const remaining = safeProjects.filter(project => project !== generalProject);
    if (projectSortOrder === "date") {
      // Most recent first. Tie-break on display name so the order is stable
      // when two projects have no recorded activity (both 0).
      return [...remaining].sort((a, b) => {
        const diff = projectLastActivity(b) - projectLastActivity(a);
        if (diff !== 0) return diff;
        return projectDisplayName(a).localeCompare(projectDisplayName(b));
      });
    }
    return [...remaining].sort((a, b) =>
      projectDisplayName(a).localeCompare(projectDisplayName(b), undefined, { sensitivity: "base" }),
    );
  }, [safeProjects, generalProject, projectSortOrder]);

  const allProjectGroupsExpanded =
    otherProjects.length > 0 && otherProjects.every(project => expandedGroups.has(project.name));

  const navToProject = useCallback((name: string) => navigate(`/p/${encodeURIComponent(name)}`), [navigate]);

  const handleGeneralSectionClick = useCallback(() => {
    setActiveSection("general");
    if (!generalProject) return;

    onResetProjectSessionPreview?.(generalProject.name);
    if (selectedProject?.name !== generalProject.name) {
      onSelectProject(generalProject);
    }
    navToProject(generalProject.name);
  }, [generalProject, navToProject, onResetProjectSessionPreview, onSelectProject, selectedProject?.name]);

  const handleProjectsSectionClick = useCallback(() => {
    if (generalProject) {
      onResetProjectSessionPreview?.(generalProject.name);
    }
    setActiveSection("projects");
  }, [generalProject, onResetProjectSessionPreview]);

  const toggleProjectExpanded = useCallback((project: Project) => {
    setExpandedGroups(previous => {
      const next = new Set(previous);
      if (next.has(project.name)) {
        next.delete(project.name);
      } else {
        next.add(project.name);
      }
      return next;
    });
  }, []);

  const toggleAllProjectGroups = useCallback(() => {
    setExpandedGroups(previous => {
      const next = new Set(previous);
      if (allProjectGroupsExpanded) {
        otherProjects.forEach(project => next.delete(project.name));
      } else {
        otherProjects.forEach(project => next.add(project.name));
      }
      return next;
    });
  }, [allProjectGroupsExpanded, otherProjects]);

  const ensureExpanded = useCallback((project: Project) => {
    setExpandedGroups(previous => {
      if (previous.has(project.name)) return previous;
      const next = new Set(previous);
      next.add(project.name);
      return next;
    });
  }, []);

  const handleProjectClick = useCallback(
    (project: Project) => {
      if (renamingProject === project.name) return;
      if (selectedProject?.name !== project.name) {
        // Clicking an unselected project switches to it (selection + main
        // area follow) and expands its session tree — the folder-open
        // behavior expected in a desktop app. Clicking the already-selected
        // project keeps toggling collapse/expand.
        onSelectProject(project);
        ensureExpanded(project);
      } else {
        toggleProjectExpanded(project);
      }
    },
    [renamingProject, selectedProject?.name, onSelectProject, ensureExpanded, toggleProjectExpanded],
  );

  const handleSessionClick = useCallback(
    (project: Project, sessionId: string) => {
      if (renamingSession === sessionId) return;
      setDraftSessionProjectName(null);
      onSelectSession(project, sessionId);
      ensureExpanded(project);
    },
    [ensureExpanded, onSelectSession, renamingSession],
  );

  const handleNewSession = useCallback(
    (event: React.MouseEvent, project: Project) => {
      event.stopPropagation();
      setDraftSessionProjectName(project.name);
      ensureExpanded(project);
      onStartNewSession(project);
      navToProject(project.name);
    },
    [ensureExpanded, navToProject, onStartNewSession],
  );

  const requestDeleteProject = useCallback(
    (project: Project) => {
      closeContextMenu();
      onRequestDeleteProject(project);
    },
    [closeContextMenu, onRequestDeleteProject],
  );

  const requestDeleteSession = useCallback(
    (project: Project, session: ProjectSession) => {
      closeContextMenu();
      onRequestDeleteSession(project, session);
    },
    [closeContextMenu, onRequestDeleteSession],
  );

  const handleContextRename = useCallback(() => {
    if (!contextMenu) return;
    closeContextMenu();
    if (contextMenu.kind === "project") {
      beginRenameProject(contextMenu.project);
    } else {
      beginRenameSession(contextMenu.session);
    }
  }, [beginRenameProject, beginRenameSession, closeContextMenu, contextMenu]);

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === "project") {
      requestDeleteProject(contextMenu.project);
    } else {
      requestDeleteSession(contextMenu.project, contextMenu.session);
    }
  }, [contextMenu, requestDeleteProject, requestDeleteSession]);

  const renderSessionRows = (project: Project, options: { flat?: boolean } = {}) => (
    <SidebarSessionRows
      project={project}
      flat={options.flat}
      sessionTreeByProject={sessionTreeByProject}
      collapsedSessionProjects={collapsedSessionProjects}
      setCollapsedSessionProjects={setCollapsedSessionProjects}
      draftSessionProjectName={draftSessionProjectName}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      activeTab={activeTab}
      processingSessions={processingSessions}
      unreadSessionIds={unreadSessionIds}
      loadingMoreProjectIds={loadingMoreProjectIds}
      renamingSession={renamingSession}
      renameDraft={renameDraft}
      setRenameDraft={setRenameDraft}
      renameInputRef={renameInputRef}
      commitSessionRename={commitSessionRename}
      handleRenameKey={handleRenameKey}
      onLoadMoreSessions={onLoadMoreSessions}
      handleSessionClick={handleSessionClick}
      handleNewSession={handleNewSession}
      openSessionContextMenu={openSessionContextMenu}
      t={t}
    />
  );

  const renderProjectGroup = (project: Project, options: { isGeneral?: boolean } = {}) => (
    <SidebarProjectGroup
      project={project}
      isGeneral={options.isGeneral}
      selectedProject={selectedProject}
      expandedGroups={expandedGroups}
      renamingProject={renamingProject}
      renameDraft={renameDraft}
      setRenameDraft={setRenameDraft}
      renameInputRef={renameInputRef}
      commitProjectRename={commitProjectRename}
      handleRenameKey={handleRenameKey}
      handleProjectClick={handleProjectClick}
      handleNewSession={handleNewSession}
      openProjectContextMenu={openProjectContextMenu}
      renderSessionRows={renderSessionRows}
      t={t}
    />
  );

  return (
    <aside
      data-sidebar-v2-root
      style={{ width: `${sidebarWidth}px` }}
      className={cn(
        // On mobile the parent wraps this aside in an overlay constrained
        // to 85vw, so force the inline width style off with !w-full there.
        "relative flex h-full shrink-0 flex-col max-md:!w-full",
        "bg-gradient-to-b from-neutral-50 via-neutral-50 to-neutral-100/60 text-neutral-900",
        "dark:from-neutral-900 dark:via-neutral-900 dark:to-neutral-950",
        "border-r border-neutral-200/80 dark:border-neutral-800/80",
        "shadow-[inset_-1px_0_0_rgba(255,255,255,0.4)] dark:shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)]",
      )}
    >
      <SidebarHeader t={t} onCollapse={onCollapse} onDeselectProject={onDeselectProject} navigate={navigate} />

      {/* Brand divider — subtle gradient line under the logo area */}
      <div className="nav-divider mx-2" />

      {/* Section toggle: a thin pill control sitting just above the scroll
          area, so it doesn't move while the list scrolls. Mirrors the look of
          familiar two-tab segmented controls (e.g. iOS, ProseMirror). */}
      <SidebarSectionToggle
        t={t}
        activeSection={activeSection}
        handleProjectsSectionClick={handleProjectsSectionClick}
        handleGeneralSectionClick={handleGeneralSectionClick}
      />

      <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-2 pb-2">
        {isLoading && safeProjects.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">
            {t("sidebar:sessions.loading", { defaultValue: "Loading..." })}
          </div>
        ) : activeSection === "projects" ? (
          <SidebarProjectsSection
            t={t}
            otherProjects={otherProjects}
            allProjectGroupsExpanded={allProjectGroupsExpanded}
            toggleAllProjectGroups={toggleAllProjectGroups}
            onCreateProject={onCreateProject}
            renderProjectGroup={renderProjectGroup}
          />
        ) : (
          <SidebarGeneralSection
            t={t}
            generalProject={generalProject}
            handleNewSession={handleNewSession}
            renderSessionRows={renderSessionRows}
          />
        )}
      </div>

      <SidebarFooter
        t={t}
        onOpenTeamPanel={onOpenTeamPanel}
        isTeamPanelOpen={isTeamPanelOpen}
        onShowSettings={onShowSettings}
      />

      {contextMenu ? (
        <SidebarContextMenu
          contextMenu={contextMenu}
          onRename={handleContextRename}
          onDelete={handleContextDelete}
          t={t}
        />
      ) : null}

      {/* Drag handle for resizing the sidebar. Sits flush against the right
          border, 4px wide; expands hit area on hover and shows a faint accent
          while dragging. Hidden on mobile (the overlay sidebar isn't resizable). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidebar:tooltips.resize", { defaultValue: "Resize sidebar" }) as string}
        onMouseDown={handleResizeStart}
        onDoubleClick={resetSidebarWidth}
        className={cn(
          "absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize select-none md:block",
          "transition-colors duration-150",
          isResizing ? "bg-brand-500/60" : "hover:bg-brand-400/40 dark:hover:bg-brand-400/30",
        )}
      />

      {/* While dragging, paint a fullscreen overlay so the cursor stays
          consistent and we don't accidentally select text in the main pane. */}
      {isResizing ? <div className="fixed inset-0 z-[60] cursor-col-resize" style={{ userSelect: "none" }} /> : null}
    </aside>
  );
}
