import React, { useCallback } from "react";
import type { ProjectSession } from "../../types/app";
import type { ChatRunMode, PermissionMode } from "../chat/types/types";
import { getThinkingModeAvailability } from "../chat/constants/thinkingModeAvailability";
import { useChatProviderState } from "../chat/hooks/useChatProviderState";

/**
 * provider 侧状态与 run/permission 模式控制（#646 B2.6）。
 * `cycles` 与权限记忆写入逻辑与搬迁前逐字一致；runMode 本体仍由父组件持有，
 * 因为 MessagesPaneV2 / ComposerV2 与 welcome 分支都要读它。
 */
export function useChatProviderControls({
  selectedSession,
  runMode,
  setRunMode,
}: {
  selectedSession: ProjectSession | null;
  runMode: ChatRunMode;
  setRunMode: React.Dispatch<React.SetStateAction<ChatRunMode>>;
}) {
  const {
    model,
    permissionMode,
    setPermissionMode: setPermissionModeRaw,
    thinkingModelContext,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    pendingApprovals,
    setPendingApprovals,
  } = useChatProviderState({ selectedSession });

  const thinkingModeAvailability = React.useMemo(
    () => getThinkingModeAvailability(thinkingModelContext),
    [thinkingModelContext],
  );

  const cycleRunMode = useCallback(() => {
    setRunMode(currentMode => {
      if (currentMode === "agent") return "plan";
      if (currentMode === "plan") return "ask";
      return "agent";
    });
  }, [setRunMode]);

  const selectPermissionMode = useCallback(
    (mode: PermissionMode) => {
      setPermissionModeRaw(mode);
      localStorage.setItem("permissionMode-default", mode);
      if (selectedSession?.id) {
        localStorage.setItem(`permissionMode-${selectedSession.id}`, mode);
      }
    },
    [setPermissionModeRaw, selectedSession?.id],
  );

  const effectivePermissionMode = runMode === "plan" ? "plan" : permissionMode;

  return {
    model,
    permissionMode,
    thinkingModeAvailability,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    pendingApprovals,
    setPendingApprovals,
    cycleRunMode,
    selectPermissionMode,
    effectivePermissionMode,
  };
}
