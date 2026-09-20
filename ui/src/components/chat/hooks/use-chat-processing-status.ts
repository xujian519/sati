import { type MutableRefObject, useEffect } from "react";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import type { ProjectSession } from "../../../types/app";

/**
 * 「处理中」状态与状态轮询 —— 从 `useChatSessionState` 拆出的独立 hook（issue #467）。
 *
 * 三条 effect 一起搬（拆分前就是连续的，且最后一条依赖 load-all 的遮罩状态）：
 *
 * 1. `processingSessions` 命中当前会话 ⇒ 置 `isLoading` / `canAbortSession`（read-only 让位）；
 * 2. 处理中且 ws 已打开 ⇒ 立刻发一帧 `check-session-status`
 *    （`includeActiveTurnMessages: false`）并按 `SESSION_STATUS_POLL_INTERVAL_MS` 兜底轮询；
 * 3. 没有更多消息时收起「加载全部」遮罩。
 *
 * ⚠️ 调用点在主 hook 里**必须在滚动锚定之后**：这三条在拆分前的展开顺序就是紧接着锚定的
 * 三条 effect（M7–M9），挪到锚定之前会改变 `isLoading` 置位与锚定快照的先后。
 */

export interface UseChatProcessingStatusArgs {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  pendingViewSessionRef: MutableRefObject<{ sessionId: string | null; startedAt: number } | null>;
  sessionIsReadOnly: boolean;
  processingSessions?: Set<string>;
  isLoading: boolean;
  setIsLoading: (value: boolean) => void;
  setCanAbortSession: (value: boolean) => void;
  ws: WebSocket | null;
  sendMessage: (message: WsMessage) => void;
  hasMoreMessages: boolean;
  setShowLoadAllOverlay: (value: boolean) => void;
}

export function useChatProcessingStatus({
  selectedSession,
  currentSessionId,
  pendingViewSessionRef,
  sessionIsReadOnly,
  processingSessions,
  isLoading,
  setIsLoading,
  setCanAbortSession,
  ws,
  sendMessage,
  hasMoreMessages,
  setShowLoadAllOverlay,
}: UseChatProcessingStatusArgs) {
  useEffect(() => {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeViewSessionId =
      selectedSession?.id || (pendingSessionId === currentSessionId ? currentSessionId : null);
    if (sessionIsReadOnly) return;
    if (!activeViewSessionId || !processingSessions) return;
    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing && !isLoading) {
      setIsLoading(true);
      setCanAbortSession(true);
    }
  }, [
    currentSessionId,
    isLoading,
    pendingViewSessionRef,
    processingSessions,
    selectedSession?.id,
    sessionIsReadOnly,
    setIsLoading,
    setCanAbortSession,
  ]);

  useEffect(() => {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeViewSessionId =
      selectedSession?.id || (pendingSessionId === currentSessionId ? currentSessionId : null);
    if (sessionIsReadOnly) return;
    if (!activeViewSessionId || !processingSessions) return;
    if (!processingSessions.has(activeViewSessionId)) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const requestStatus = () => {
      sendMessage({
        type: "check-session-status",
        sessionId: activeViewSessionId,
        provider: "sati",
        includeActiveTurnMessages: false,
      });
    };

    requestStatus();
    // 兜底存活探测：turn 开始/结束已有 stream_end/complete 事件驱动，
    // 5s 间隔足以维持中断按钮等状态的实时性，避免 1.2s 高频 session-status
    // 帧触发消费方整树 re-render（长任务数十分钟累计请求量减半）。
    const timer = setInterval(requestStatus, UI_TIMEOUTS.SESSION_STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [
    currentSessionId,
    pendingViewSessionRef,
    processingSessions,
    selectedSession?.id,
    sendMessage,
    sessionIsReadOnly,
    ws,
  ]);

  // "Load all" overlay：没有更多消息时收起遮罩。
  // 原先这里还有一条「上一轮在加载、这一轮加载结束、且还有更多」的分支，靠 isLoadingMoreMessages
  // 的状态迁移触发；但那个状态是 `useState(false)` 且**没有 setter**（恒 false），该分支从未执行过，
  // 已随死状态一并删除（#159 N02）。遮罩的置位仍由 loadAllMessages() 与下方的完成态 effect 负责。
  useEffect(() => {
    if (!hasMoreMessages) setShowLoadAllOverlay(false);
  }, [hasMoreMessages, setShowLoadAllOverlay]);
}
