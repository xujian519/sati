import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { AppTab } from "../../../types/app";

type UseServiceWorkerNavigationArgs = {
  navigate: NavigateFunction;
  refreshProjectsSilently: () => Promise<void>;
  setActiveTab: (tab: AppTab) => void;
  setSidebarOpen: (open: boolean) => void;
};

/** 浏览器通知（Service Worker `notification:navigate`）→ 会话跳转。 */
export function useServiceWorkerNavigation({
  navigate,
  refreshProjectsSilently,
  setActiveTab,
  setSidebarOpen,
}: UseServiceWorkerNavigationArgs) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== "notification:navigate") return;

      // Provider hint from notifications is no longer stored; all sessions
      // go through the unified sati gateway.

      setActiveTab("chat");
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === "string" && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }
      navigate("/");
    };

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);
}
