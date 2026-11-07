import SidebarV2 from "../SidebarV2";
import type { AppShellState } from "./useAppShellState";
import type { AppShellChrome } from "./useAppShellChrome";
import type { SessionActions } from "./useSessionActions";
import type { NewProjectWizard } from "./useNewProjectWizard";
import type { DeleteProjectState, DeleteSessionState } from "./useDeleteDialogs";

type AppShellSidebarProps = {
  isMobile: boolean;
  sidebarOpen: boolean;
  desktopSidebarOpen: boolean;
  onCloseSidebar: () => void;
  projectState: AppShellState["projectState"];
  sessionProtection: AppShellState["sessionProtection"];
  unreadSessionIds: Set<string>;
  actions: SessionActions;
  chrome: AppShellChrome;
  wizard: NewProjectWizard;
  deleteProject: DeleteProjectState;
  deleteSession: DeleteSessionState;
};

/** 桌面侧栏常驻 / 移动端抽屉；两种形态共用同一个 SidebarV2 实例。 */
export default function AppShellSidebar({
  isMobile,
  sidebarOpen,
  desktopSidebarOpen,
  onCloseSidebar,
  projectState,
  sessionProtection,
  unreadSessionIds,
  actions,
  chrome,
  wizard,
  deleteProject,
  deleteSession,
}: AppShellSidebarProps) {
  const sidebar = (
    <SidebarV2
      projects={projectState.sidebarSharedProps.projects}
      selectedProject={projectState.selectedProject}
      selectedSession={projectState.selectedSession}
      activeTab={projectState.activeTab}
      isLoading={projectState.isLoadingProjects}
      processingSessions={sessionProtection.processingSessions}
      unreadSessionIds={unreadSessionIds}
      onSelectProject={actions.handleSelectProject}
      onSelectSession={actions.handleSelectSession}
      onStartNewSession={actions.handleStartNewSession}
      onCreateProject={wizard.handleOpenNewProject}
      onRequestDeleteProject={deleteProject.requestDeleteProject}
      onRequestDeleteSession={deleteSession.requestDeleteSession}
      onShowSettings={chrome.onShowSettings}
      onOpenTeamPanel={chrome.onOpenTeamPanel}
      isTeamPanelOpen={chrome.teamPanelOpen}
      onDeselectProject={projectState.handleDeselectProject}
      onResetProjectSessionPreview={projectState.handleResetProjectSessionPreview}
      onCollapse={chrome.onCollapseSidebar}
      onLoadMoreSessions={projectState.loadMoreSessions}
      loadingMoreProjectIds={projectState.loadingMoreProjectIds}
    />
  );

  if (!isMobile) {
    return desktopSidebarOpen ? sidebar : null;
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex transition-opacity duration-150 ease-out ${
        sidebarOpen ? "visible opacity-100" : "invisible opacity-0"
      }`}
    >
      <button
        type="button"
        className="fixed inset-0 bg-black/40 backdrop-blur-xs"
        onClick={onCloseSidebar}
        aria-label="Close sidebar"
      />
      <div
        className={`relative h-full w-[85vw] max-w-sm transform transition-transform duration-150 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        onClick={e => e.stopPropagation()}
      >
        {sidebar}
      </div>
    </div>
  );
}
