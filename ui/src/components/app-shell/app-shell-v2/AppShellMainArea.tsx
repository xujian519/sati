import MainAreaV2 from "../MainAreaV2";
import { HookTrustBanner } from "../../hook-trust/view/HookTrustBanner";
import { KnowledgeDraftsBanner } from "../../knowledge-drafts/view/KnowledgeDraftsBanner";
import type { AppShellState } from "./useAppShellState";
import type { AppShellChrome } from "./useAppShellChrome";
import type { SessionActions } from "./useSessionActions";

type AppShellMainAreaProps = {
  isMobile: boolean;
  websocket: AppShellState["websocket"];
  sessionProtection: AppShellState["sessionProtection"];
  projectState: AppShellState["projectState"];
  desktopSidebar: AppShellState["desktopSidebar"];
  unreadSessionIds: Set<string>;
  actions: SessionActions;
  chrome: AppShellChrome;
  misroutedFileFromUrl: string | null;
  onMisroutedFileUrlHandled: () => void;
};

/** 主区：信任/知识草稿横幅 + MainAreaV2（面包屑 + 工具切换 + 内容）。 */
export default function AppShellMainArea({
  isMobile,
  websocket,
  sessionProtection,
  projectState,
  desktopSidebar,
  unreadSessionIds,
  actions,
  chrome,
  misroutedFileFromUrl,
  onMisroutedFileUrlHandled,
}: AppShellMainAreaProps) {
  const { selectedProject, selectedSession, activeTab, isLoadingProjects, externalMessageUpdate, setIsInputFocused } =
    projectState;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <HookTrustBanner projectPath={selectedProject?.fullPath || selectedProject?.path || null} />
      <KnowledgeDraftsBanner />
      <MainAreaV2
        projects={projectState.sidebarSharedProps.projects}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        activeTab={activeTab}
        setActiveTab={actions.handleSelectTab}
        ws={websocket.ws}
        sendMessage={websocket.sendMessage}
        latestMessage={websocket.latestMessage}
        isMobile={isMobile}
        onMenuClick={chrome.onMenuClick}
        isLoading={isLoadingProjects}
        onInputFocusChange={setIsInputFocused}
        onSessionActive={sessionProtection.markSessionAsActive}
        onSessionInactive={actions.handleSessionInactive}
        onSessionProcessing={sessionProtection.markSessionAsProcessing}
        onSessionNotProcessing={sessionProtection.markSessionAsNotProcessing}
        onSessionActivityBump={projectState.bumpSessionActivity}
        processingSessions={sessionProtection.processingSessions}
        unreadSessionIds={unreadSessionIds}
        onReplaceTemporarySession={actions.handleReplaceTemporarySession}
        onNavigateToSession={actions.handleNavigateToSession}
        onStartNewSession={actions.handleStartNewSession}
        onSelectSession={actions.handleSelectSession}
        onShowSettings={chrome.onShowSettings}
        onSelectProjectByName={actions.handleSelectProjectByName}
        isSidebarCollapsed={!isMobile && !desktopSidebar.desktopSidebarOpen}
        onOpenSidebar={desktopSidebar.openDesktopSidebar}
        externalMessageUpdate={externalMessageUpdate}
        misroutedFileFromUrl={misroutedFileFromUrl}
        onMisroutedFileUrlHandled={onMisroutedFileUrlHandled}
        teamPanelOpen={chrome.teamPanelOpen}
        onTeamPanelClose={chrome.onTeamPanelClose}
      />
    </main>
  );
}
