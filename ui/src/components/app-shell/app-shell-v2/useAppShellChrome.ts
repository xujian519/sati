import { useCallback, useState } from "react";

type UseAppShellChromeArgs = {
  isMobile: boolean;
  setSidebarOpen: (open: boolean) => void;
  setShowSettings: (open: boolean) => void;
  collapseDesktopSidebar: () => void;
};

/** 外壳 chrome 的开关：设置面板、移动端抽屉/桌面侧栏、团队活动浮层。 */
export function useAppShellChrome({
  isMobile,
  setSidebarOpen,
  setShowSettings,
  collapseDesktopSidebar,
}: UseAppShellChromeArgs) {
  // 团队活动浮层开关（侧边栏 Team 按钮切换；非 AppTab，无 URL 路由）
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);

  const onShowSettings = useCallback(() => setShowSettings(true), [setShowSettings]);
  const onCloseSettings = useCallback(() => setShowSettings(false), [setShowSettings]);
  const onMenuClick = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const onCloseSidebar = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);
  const onCollapseSidebar = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
    } else {
      collapseDesktopSidebar();
    }
  }, [collapseDesktopSidebar, isMobile, setSidebarOpen]);
  const onOpenTeamPanel = useCallback(() => setTeamPanelOpen(prev => !prev), []);
  const onTeamPanelClose = useCallback(() => setTeamPanelOpen(false), []);

  return {
    teamPanelOpen,
    onShowSettings,
    onCloseSettings,
    onMenuClick,
    onCloseSidebar,
    onCollapseSidebar,
    onOpenTeamPanel,
    onTeamPanelClose,
  };
}

export type AppShellChrome = ReturnType<typeof useAppShellChrome>;
