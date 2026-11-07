import ErrorBoundary from "../main-content/view/ErrorBoundary";
import { ConnectionBanner } from "../ui/ConnectionBanner";
import AppShellMainArea from "./app-shell-v2/AppShellMainArea";
import AppShellOverlays from "./app-shell-v2/AppShellOverlays";
import AppShellSidebar from "./app-shell-v2/AppShellSidebar";
import { useAppShellChrome } from "./app-shell-v2/useAppShellChrome";
import { useAppShellGlobals } from "./app-shell-v2/useAppShellGlobals";
import { useAppShellRoute } from "./app-shell-v2/useAppShellRoute";
import { useAppShellSelection } from "./app-shell-v2/useAppShellSelection";
import { useAppShellState } from "./app-shell-v2/useAppShellState";
import { useDeleteProject, useDeleteSession } from "./app-shell-v2/useDeleteDialogs";
import { useNewProjectWizard } from "./app-shell-v2/useNewProjectWizard";
import { usePendingPermissionsSync } from "./app-shell-v2/usePendingPermissionsSync";
import { useServiceWorkerNavigation } from "./app-shell-v2/useServiceWorkerNavigation";
import { useSessionActions } from "./app-shell-v2/useSessionActions";
import { useUnreadSessions } from "./app-shell-v2/useUnreadSessions";

// V2 shell. Reuses the same data hooks as legacy AppContent so chat, discovery,
// auth, and project plumbing keep working unchanged — V2 just reorganizes the
// outer chrome (sidebar + breadcrumb header per prototype/shadcn.html).
export default function AppShellV2() {
  const { navigate, projectNameParam, sessionId } = useAppShellRoute();
  const {
    isMobile,
    websocket,
    sessionProtection,
    projectState,
    desktopSidebar,
    misroutedFileFromUrl,
    handleMisroutedFileUrlHandled,
  } = useAppShellState({ sessionId, navigate });

  const { userSelectedProjectRef, switchProject } = useAppShellSelection({
    projectNameParam,
    sessionId,
    isLoadingProjects: projectState.isLoadingProjects,
    projects: projectState.sidebarSharedProps.projects,
    selectedProject: projectState.selectedProject,
    handleProjectSelect: projectState.handleProjectSelect,
    navigate,
  });

  const { unreadSessionIds, markSessionRead } = useUnreadSessions({
    selectedSessionId: projectState.selectedSession?.id,
    subscribe: websocket.subscribe,
  });

  useAppShellGlobals({
    refreshProjectsSilently: projectState.refreshProjectsSilently,
    openSettings: projectState.openSettings,
    switchProject,
  });

  useServiceWorkerNavigation({
    navigate,
    refreshProjectsSilently: projectState.refreshProjectsSilently,
    setActiveTab: projectState.setActiveTab,
    setSidebarOpen: projectState.setSidebarOpen,
  });

  usePendingPermissionsSync({
    isConnected: websocket.isConnected,
    selectedSessionId: projectState.selectedSession?.id,
    sendMessage: websocket.sendMessage,
  });

  const chrome = useAppShellChrome({
    isMobile,
    setSidebarOpen: projectState.setSidebarOpen,
    setShowSettings: projectState.setShowSettings,
    collapseDesktopSidebar: desktopSidebar.collapseDesktopSidebar,
  });

  const wizard = useNewProjectWizard({
    navigate,
    refreshProjectsSilently: projectState.refreshProjectsSilently,
    handleNewSession: projectState.handleNewSession,
    setActiveTab: projectState.setActiveTab,
    userSelectedProjectRef,
  });

  const actions = useSessionActions({
    navigate,
    projects: projectState.sidebarSharedProps.projects,
    selectedProject: projectState.selectedProject,
    userSelectedProjectRef,
    handleProjectSelect: projectState.handleProjectSelect,
    handleSessionSelect: projectState.handleSessionSelect,
    handleNewSession: projectState.handleNewSession,
    replaceTemporarySession: sessionProtection.replaceTemporarySession,
    markSessionAsInactive: sessionProtection.markSessionAsInactive,
    replaceOptimisticInProjects: projectState.replaceOptimisticInProjects,
    dropOptimisticInProjects: projectState.dropOptimisticInProjects,
    setActiveTab: projectState.setActiveTab,
    setSelectedProject: projectState.setSelectedProject,
    setSelectedSession: projectState.setSelectedSession,
    markSessionRead,
  });

  const deleteProject = useDeleteProject({
    refreshProjectsSilently: projectState.refreshProjectsSilently,
    onProjectDelete: projectState.sidebarSharedProps.onProjectDelete,
  });

  const deleteSession = useDeleteSession({
    refreshProjectsSilently: projectState.refreshProjectsSilently,
    onSessionDelete: projectState.sidebarSharedProps.onSessionDelete,
    markSessionRead,
  });

  return (
    <ErrorBoundary>
      <div className="ui-v2 fixed inset-0 flex flex-col bg-white font-sans text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <ConnectionBanner />
        <div className="flex min-h-0 flex-1">
          <AppShellSidebar
            isMobile={isMobile}
            sidebarOpen={projectState.sidebarOpen}
            desktopSidebarOpen={desktopSidebar.desktopSidebarOpen}
            onCloseSidebar={chrome.onCloseSidebar}
            projectState={projectState}
            sessionProtection={sessionProtection}
            unreadSessionIds={unreadSessionIds}
            actions={actions}
            chrome={chrome}
            wizard={wizard}
            deleteProject={deleteProject}
            deleteSession={deleteSession}
          />

          <AppShellMainArea
            isMobile={isMobile}
            websocket={websocket}
            sessionProtection={sessionProtection}
            projectState={projectState}
            desktopSidebar={desktopSidebar}
            unreadSessionIds={unreadSessionIds}
            actions={actions}
            chrome={chrome}
            misroutedFileFromUrl={misroutedFileFromUrl}
            onMisroutedFileUrlHandled={handleMisroutedFileUrlHandled}
          />

          <AppShellOverlays
            projectState={projectState}
            websocket={websocket}
            chrome={chrome}
            wizard={wizard}
            deleteProject={deleteProject}
            deleteSession={deleteSession}
          />
        </div>
      </div>
    </ErrorBoundary>
  );
}
