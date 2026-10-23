import { asRecord } from "../../../utils/unknown";
import type { ClaudeWorkStatus, CompactProgress, PendingPermissionRequest } from "../types/types";
import {
  getActiveTurnReplayMessagesToApply,
  getExplicitSessionId,
  toNormalizedMessage,
} from "./chatRealtimeMessageUtils";
import type { ChatRealtimeHandlerDeps, ChatRealtimeMessageHandler, LatestChatMessage } from "./chatRealtimeTypes";

type LegacyHandlerArgs = {
  deps: ChatRealtimeHandlerDeps;
  handleMessage: ChatRealtimeMessageHandler;
};

export function createLegacyMessageHandler({ deps, handleMessage }: LegacyHandlerArgs) {
  const {
    selectedSession,
    currentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setSatiStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    thinkingBySessionRef,
    activeTurnReplaySignatureRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onWebSocketReconnect,
    sessionStore,
    clearSessionStatusRetry,
    scheduleSessionStatusRetry,
  } = deps;

  const clearAccumulators = () => {
    thinkingBySessionRef.current.clear();
  };

  return (msg: LatestChatMessage, activeViewSessionId: string | null): void => {
    const messageType = String(msg.type || "");

    switch (messageType) {
      case "websocket-reconnected":
        clearAccumulators();
        onWebSocketReconnect?.();
        return;

      case "pending-permissions-response": {
        const permSessionId = msg.sessionId;
        const isCurrentPermSession =
          permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
        if (permSessionId && !isCurrentPermSession) return;
        setPendingPermissionRequests(Array.isArray(msg.data) ? (msg.data as PendingPermissionRequest[]) : []);
        return;
      }

      case "session-status": {
        const statusSessionId = msg.sessionId;
        if (!statusSessionId) return;
        // A selected conversation always takes precedence over the last
        // loaded id: during a session switch React can render once with
        // the new selection while `currentSessionId` still points at the
        // previous conversation. A status frame from the previous
        // conversation must not overwrite the newly selected one's status
        // (including compaction progress).
        const isCurrentSession = statusSessionId === activeViewSessionId;

        if (isCurrentSession && Array.isArray(msg.activeTurnMessages) && msg.activeTurnMessages.length > 0) {
          clearAccumulators();
          const slot = sessionStore.getSessionSlot?.(statusSessionId);
          const hasLiveStreaming = Boolean(
            slot?.realtimeMessages?.some(
              message =>
                message.id === `__streaming_${statusSessionId}` ||
                message.id.startsWith(`__streaming_${statusSessionId}_`) ||
                message.id === `__streaming_thinking_${statusSessionId}` ||
                message.id.startsWith(`__streaming_thinking_${statusSessionId}_`),
            ),
          );
          const replayedToolIds = new Set(
            (slot?.realtimeMessages || [])
              .filter(message => message.kind === "tool_use" && typeof message.toolId === "string")
              .map(message => message.toolId as string),
          );
          const activeTurnToolIds = new Set(
            msg.activeTurnMessages
              .filter(message => message?.kind === "tool_use" && typeof message?.toolId === "string")
              .map(message => message.toolId as string),
          );
          const hasReplayedCurrentTurnToolUse =
            activeTurnToolIds.size > 0 && [...activeTurnToolIds].some(toolId => replayedToolIds.has(toolId));
          const volatileSignature = msg.activeTurnMessages
            .filter(message => ["thinking", "stream_delta", "stream_end"].includes(String(message?.kind)))
            .map(message => `${message.kind}:${message.id || ""}:${message.content || ""}`)
            .join("||");
          const previousVolatileSignature = activeTurnReplaySignatureRef.current.get(statusSessionId);
          const hasSeenSameVolatileReplay = Boolean(
            volatileSignature && previousVolatileSignature === volatileSignature,
          );
          // Replay active-turn snapshots only for content this tab has not
          // already rendered. Volatile stream/thinking chunks are grouped
          // into blocks so a status poll cannot re-feed an already-finalized
          // assistant text back into the streaming accumulator.
          const skipVolatileReplay = hasLiveStreaming || hasReplayedCurrentTurnToolUse || hasSeenSameVolatileReplay;
          const activeTurnMessagesToApply = getActiveTurnReplayMessagesToApply(
            msg.activeTurnMessages,
            {
              realtimeMessages: slot?.realtimeMessages || [],
              serverMessages: slot?.serverMessages || [],
            },
            { skipVolatile: skipVolatileReplay },
          );
          for (const activeTurnMessage of activeTurnMessagesToApply) {
            handleMessage(activeTurnMessage, statusSessionId);
          }
          if (volatileSignature) {
            activeTurnReplaySignatureRef.current.set(statusSessionId, volatileSignature);
          }
        }

        if (isCurrentSession && Array.isArray(msg.activitySnapshot)) {
          const activities = msg.activitySnapshot.map(activity => {
            const normalized = toNormalizedMessage(activity);
            if (getExplicitSessionId(normalized)) return normalized;
            return { ...normalized, sessionId: statusSessionId };
          });
          sessionStore.setActivities?.(statusSessionId, activities);
        }

        const status = asRecord(msg.status);
        if (status) {
          if (!isCurrentSession) return;
          const statusInfo: ClaudeWorkStatus = {
            text: typeof status.text === "string" ? status.text : "Working...",
            tokens: typeof status.tokens === "number" ? status.tokens : 0,
            can_interrupt: status.can_interrupt === undefined ? true : Boolean(status.can_interrupt),
            compactProgress:
              (status.compactProgress as CompactProgress | undefined) ||
              (status.compact_progress as CompactProgress | undefined) ||
              null,
          };
          setClaudeStatus(statusInfo);
          setSatiStatus(statusInfo);
          setIsLoading(true);
          setCanAbortSession(statusInfo.can_interrupt);
          return;
        }

        if (isCurrentSession && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        }

        // Legacy isProcessing format from check-session-status. A null
        // value means gateway activity could not be confirmed (unknown):
        // keep the current UI state and retry instead of reporting the
        // session as inactive.
        if (msg.isProcessing === null) {
          if (isCurrentSession) {
            scheduleSessionStatusRetry(statusSessionId);
          }
          return;
        }
        if (msg.isProcessing) {
          clearSessionStatusRetry(statusSessionId);
          onSessionProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(true);
            setCanAbortSession(true);
          }
          return;
        }
        clearSessionStatusRetry(statusSessionId);
        onSessionInactive?.(statusSessionId);
        onSessionNotProcessing?.(statusSessionId);
        if (isCurrentSession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          setSatiStatus(null);
        }
        return;
      }

      default:
        // Unknown legacy message type — ignore
        return;
    }
  };
}
