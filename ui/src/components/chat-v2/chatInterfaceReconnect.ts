import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { Project, ProjectSession, SessionRequestParams } from "../../types/app";
import type { SessionStore } from "../../stores/useSessionStore";
import type { ChatInterfaceProps } from "../chat/types/types";
import {
  buildReconnectStatusMessage,
  refreshSessionAfterReconnect,
  shouldRefreshSessionOnReconnect,
} from "./reconnectRecovery";

/**
 * WebSocket 重连恢复（#646 B2.6）：
 * 清流式缓冲 → 空闲会话拉全量刷新 → 统一发 check-session-status 让后端回报真实 turn 状态。
 * refs 与 sendMessage 均按原句柄透传，deps 语义不变。
 */
export function useChatWebSocketReconnect({
  isLoading,
  processingSessions,
  selectedProject,
  selectedSession,
  sessionRequestParams,
  sessionStore,
  streamTimerRef,
  accumulatedStreamRef,
  streamBufferRef,
  sendMessage,
}: {
  isLoading: boolean;
  processingSessions?: Set<string>;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  sessionRequestParams: SessionRequestParams;
  sessionStore: SessionStore;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  streamBufferRef: MutableRefObject<string>;
  sendMessage: ChatInterfaceProps["sendMessage"];
}) {
  return useCallback(async () => {
    if (!selectedProject || !selectedSession) return;

    // Reset streaming refs so stale accumulated text from the previous
    // connection doesn't merge with freshly-fetched server messages.
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = "";
    streamBufferRef.current = "";

    if (shouldRefreshSessionOnReconnect({ isLoading, processingSessions, sessionId: selectedSession.id })) {
      await refreshSessionAfterReconnect(() =>
        sessionStore.refreshFromServer(selectedSession.id, {
          provider: "sati",
          projectName: selectedProject.name,
          projectPath: selectedProject.fullPath || selectedProject.path || "",
          ...sessionRequestParams,
        }),
      );
    }

    // Ask the backend whether the session is still processing so the
    // loading indicator, Stop button, and active turn replay reflect reality
    // after reconnect. The session-status handler consumes activeTurnMessages
    // and dedupes replay chunks against existing realtime state.
    sendMessage(buildReconnectStatusMessage(selectedSession.id));
  }, [
    isLoading,
    processingSessions,
    selectedProject,
    selectedSession,
    sessionRequestParams,
    sessionStore,
    streamTimerRef,
    accumulatedStreamRef,
    streamBufferRef,
    sendMessage,
  ]);
}
