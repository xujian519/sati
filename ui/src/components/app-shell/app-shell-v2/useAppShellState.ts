import { useCallback, useMemo } from "react";
import type { NavigateFunction } from "react-router-dom";
import { useWebSocket } from "../../../contexts/WebSocketContext";
import { useDesktopSidebarForFiles } from "../../../hooks/useDesktopSidebarForFiles";
import { useProjectsState } from "../../../hooks/useProjectsState";
import { useSessionProtection } from "../../../hooks/useSessionProtection";
import { useDeviceSettings } from "../../../hooks/useDeviceSettings";
import { resolveMarkdownFileHref } from "../../chat/utils/resolveMarkdownFileHref";

type UseAppShellStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
};

/**
 * 外壳的数据层：设备信息、WebSocket、会话保护、项目状态与桌面侧栏开关。
 * 与旧 AppContent 复用同一批 hook，保证聊天/发现/鉴权/项目管线行为不变。
 */
export function useAppShellState({ sessionId, navigate }: UseAppShellStateArgs) {
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const websocket = useWebSocket();
  const sessionProtection = useSessionProtection();
  const projectState = useProjectsState({
    sessionId,
    navigate,
    latestMessage: websocket.latestMessage,
    isMobile,
    activeSessions: sessionProtection.activeSessions,
  });
  const desktopSidebar = useDesktopSidebarForFiles({
    activeTab: projectState.activeTab,
    isMobile,
  });

  const misroutedFileFromUrl = useMemo(() => {
    if (!sessionId) return null;
    const filePath = resolveMarkdownFileHref(`/session/${sessionId}`);
    if (!filePath) return null;
    if (projectState.isLoadingProjects) return filePath;
    const hasMatchingSession = projectState.sidebarSharedProps.projects.some(project =>
      (project.sessions ?? []).some(session => session.id === sessionId),
    );
    return hasMatchingSession ? null : filePath;
  }, [sessionId, projectState.isLoadingProjects, projectState.sidebarSharedProps.projects]);

  const handleMisroutedFileUrlHandled = useCallback(() => {
    const target = projectState.selectedProject ? `/p/${encodeURIComponent(projectState.selectedProject.name)}` : "/";
    navigate(target, { replace: true });
  }, [navigate, projectState.selectedProject]);

  return {
    isMobile,
    websocket,
    sessionProtection,
    projectState,
    desktopSidebar,
    misroutedFileFromUrl,
    handleMisroutedFileUrlHandled,
  };
}

export type AppShellState = ReturnType<typeof useAppShellState>;
