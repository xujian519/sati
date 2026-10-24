import { useCallback, useEffect, useState } from "react";
import type { ProjectSession } from "../../types/app";

/**
 * abort 的 pending 闸门（#646 B2.6）：
 * ① 状态失效两条 effect（turn 结束 / 会话切换）② 去重的 handleAbortWithPending
 * ③ 全局 Escape 监听。三条 effect 的注册顺序与搬迁前一致（重置 ×2 → Escape）。
 */
export function useChatAbortGuard({
  isLoading,
  canAbortSession,
  currentSessionId,
  selectedSession,
  handleAbortSession,
}: {
  isLoading: boolean;
  canAbortSession: boolean;
  currentSessionId: string | null;
  selectedSession: ProjectSession | null;
  handleAbortSession: () => void;
}) {
  const [isAbortPending, setIsAbortPending] = useState(false);

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      setIsAbortPending(false);
    }
  }, [canAbortSession, isLoading]);

  useEffect(() => {
    setIsAbortPending(false);
  }, [currentSessionId, selectedSession?.id]);

  const handleAbortWithPending = useCallback(() => {
    if (!isLoading || !canAbortSession || isAbortPending) return;
    handleAbortSession();
    setIsAbortPending(true);
  }, [canAbortSession, handleAbortSession, isAbortPending, isLoading]);

  useEffect(() => {
    if (!isLoading || !canAbortSession) return;
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.defaultPrevented) return;
      if (document.querySelector("[data-modal-overlay]")) return;
      event.preventDefault();
      handleAbortWithPending();
    };
    document.addEventListener("keydown", handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortWithPending, isLoading]);

  return { isAbortPending, handleAbortWithPending };
}
