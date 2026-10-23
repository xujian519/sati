import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { PendingApproval, PendingPermissionRequest, RetryProgress } from "../types/types";
import { parseRequestOrigin } from "./chatRealtimeMessageUtils";
import type { ChatRealtimeFrame, ChatRealtimeHandlerDeps } from "./chatRealtimeTypes";

type SideEffectScope = ChatRealtimeHandlerDeps & {
  clearActiveTurnUiState: () => void;
  refreshSessionFromServer: (sessionId: string) => Promise<void>;
};

type SideEffectHandler = (frame: ChatRealtimeFrame, scope: SideEffectScope) => void;

function handleFileArtifacts(
  { msg, sid, isForActiveView }: ChatRealtimeFrame,
  { selectedProject }: SideEffectScope,
): void {
  if (isForActiveView && selectedProject?.name && Array.isArray(msg.artifacts)) {
    for (const artifact of msg.artifacts) {
      if (!artifact || typeof artifact.path !== "string" || !artifact.path.trim()) continue;
      window.dispatchEvent(
        new CustomEvent("sati:file-updated", {
          detail: {
            sessionId: sid,
            projectName: selectedProject.name,
            filePath: artifact.path,
            operation: artifact.operation,
          },
        }),
      );
    }
  }
}

function handleSessionCreated(
  { msg }: ChatRealtimeFrame,
  {
    currentSessionId,
    setCurrentSessionId,
    pendingViewSessionRef,
    sessionStore,
    setPendingPermissionRequests,
    onReplaceTemporarySession,
    onNavigateToSession,
  }: SideEffectScope,
): void {
  const newSessionId = msg.newSessionId;
  if (!newSessionId) return;

  if (!currentSessionId || currentSessionId.startsWith("new-session-")) {
    sessionStorage.setItem("pendingSessionId", newSessionId);
    if (pendingViewSessionRef.current && !pendingViewSessionRef.current.sessionId) {
      pendingViewSessionRef.current.sessionId = newSessionId;
    }
    setCurrentSessionId(newSessionId);
    // Eagerly set activeSession so that notify() works for
    // stream_delta events that arrive before React re-renders.
    sessionStore.setActiveSession(newSessionId);
    onReplaceTemporarySession?.(newSessionId);
    setPendingPermissionRequests(prev => prev.map(r => (r.sessionId ? r : { ...r, sessionId: newSessionId })));
    onNavigateToSession?.(newSessionId);
  }
  if (window.refreshProjects) {
    void window.refreshProjects();
  }
}

function handleComplete({ msg, sid, msgRunId, isForActiveView }: ChatRealtimeFrame, scope: SideEffectScope): void {
  const {
    selectedProject,
    currentSessionId,
    setCurrentSessionId,
    setPendingPermissionRequests,
    thinkingBySessionRef,
    activeTurnReplaySignatureRef,
    onSessionInactive,
    onSessionNotProcessing,
    onNavigateToSession,
    onRewriteError,
    sessionStore,
    clearSessionStatusRetry,
    clearActiveTurnUiState,
    refreshSessionFromServer,
  } = scope;

  // 协议 1.7：turn 改写失败（complete 帧不可渲染，回调宿主提示）。
  const rewriteError = typeof msg.rewriteError === "string" ? msg.rewriteError : "";
  if (rewriteError) {
    onRewriteError?.(rewriteError);
  }
  if (sid) {
    clearSessionStatusRetry(sid);
    activeTurnReplaySignatureRef.current.delete(sid);
    // Finalize both thinking and content streams
    if (thinkingBySessionRef.current.has(sid)) {
      thinkingBySessionRef.current.delete(sid);
    }
    sessionStore.finalizeStreamingThinking(sid, msgRunId);
    sessionStore.finalizeStreaming(sid, msgRunId);
  }

  if (isForActiveView) {
    clearActiveTurnUiState();
  }
  if (sid) {
    setPendingPermissionRequests(prev => prev.filter(r => r.sessionId !== sid));
    onSessionInactive?.(sid);
    onSessionNotProcessing?.(sid);
    window.dispatchEvent(
      new CustomEvent("sati:agent-turn-complete", {
        detail: {
          sessionId: sid,
          projectName: selectedProject?.name,
          projectPath: selectedProject?.fullPath || selectedProject?.path || "",
        },
      }),
    );

    // Auto-refresh from server to align with canonical message order.
    // During streaming, messages may arrive out of order (e.g. content
    // stream created before tool_use). The server has the authoritative
    // copy with correct ordering. Retry if server hasn't committed yet.
    const doRefresh = (attempt: number) => {
      refreshSessionFromServer(sid).then(() => {
        const slot = sessionStore.getSessionSlot?.(sid);
        if (slot && slot.serverMessages.length === 0 && attempt < 5) {
          setTimeout(() => doRefresh(attempt + 1), 1500 * attempt);
        }
      });
    };
    doRefresh(1);
  }

  // Handle aborted case
  if (msg.aborted) {
    // Abort was requested — the complete event confirms it
    // No special UI action needed beyond clearing loading state above
    // The backend already sent any abort-related messages
    return;
  }

  // Clear pending session
  const pendingSessionId = sessionStorage.getItem("pendingSessionId");
  if (pendingSessionId && sid === pendingSessionId && msg.exitCode === 0) {
    const actualId = msg.actualSessionId || pendingSessionId;
    if (!currentSessionId) {
      setCurrentSessionId(actualId);
    }
    if (msg.actualSessionId) {
      onNavigateToSession?.(actualId);
    }
    sessionStorage.removeItem("pendingSessionId");
    if (window.refreshProjects) {
      setTimeout(() => window.refreshProjects?.(), UI_TIMEOUTS.SESSION_EXIT_PROJECT_REFRESH_MS);
    }
  }
}

function handleError(
  { sid, isForActiveView }: ChatRealtimeFrame,
  {
    activeTurnReplaySignatureRef,
    onSessionInactive,
    onSessionNotProcessing,
    clearSessionStatusRetry,
    clearActiveTurnUiState,
    refreshSessionFromServer,
  }: SideEffectScope,
): void {
  if (isForActiveView) {
    clearActiveTurnUiState();
  }
  if (sid) {
    clearSessionStatusRetry(sid);
    activeTurnReplaySignatureRef.current.delete(sid);
    onSessionInactive?.(sid);
    onSessionNotProcessing?.(sid);
    refreshSessionFromServer(sid);
  }
}

function handlePermissionRequest(
  { msg, sid, isForActiveView }: ChatRealtimeFrame,
  {
    onSessionProcessing,
    setPendingPermissionRequests,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setSatiStatus,
  }: SideEffectScope,
): void {
  const requestId = msg.requestId;
  if (!requestId) return;
  const isForCurrentSession = isForActiveView;
  if (!isForCurrentSession) return;
  onSessionProcessing?.(sid);
  setPendingPermissionRequests(prev => {
    if (prev.some((r: PendingPermissionRequest) => r.requestId === requestId)) return prev;
    const origin = parseRequestOrigin(msg.origin);
    return [
      ...prev,
      {
        requestId,
        toolName: msg.toolName || "UnknownTool",
        input: msg.input,
        context: msg.context,
        ...(origin ? { origin } : {}),
        sessionId: sid,
        receivedAt: new Date(),
        isElicitation: Boolean((msg as { isElicitation?: boolean }).isElicitation),
      },
    ];
  });
  setIsLoading(true);
  setCanAbortSession(true);
  setClaudeStatus({ text: "Waiting for permission", tokens: 0, can_interrupt: true });
  setSatiStatus({ text: "Waiting for permission", tokens: 0, can_interrupt: true });
}

function handlePermissionCancelled(
  { msg }: ChatRealtimeFrame,
  { setPendingPermissionRequests }: SideEffectScope,
): void {
  if (msg.requestId) {
    setPendingPermissionRequests(prev => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
  }
}

function handleApprovalPending(
  { msg, sid, isForActiveView }: ChatRealtimeFrame,
  { onSessionProcessing, setPendingApprovals }: SideEffectScope,
): void {
  // 输出门禁 HITL 审批：专利结论挂起等待人工审批（非当前会话的挂起不显示）。
  if (!isForActiveView) return;
  const pendingIndex = msg.pendingIndex;
  if (typeof pendingIndex !== "number") return;
  onSessionProcessing?.(sid);
  setPendingApprovals(prev => {
    if (prev.some((a: PendingApproval) => a.pendingIndex === pendingIndex)) return prev;
    return [
      ...prev,
      {
        pendingIndex,
        textPreview: typeof msg.textPreview === "string" ? msg.textPreview : "",
        triggerKeyword: typeof msg.triggerKeyword === "string" ? msg.triggerKeyword : "approval",
        uiSessionId: typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        sessionId: typeof msg.agentSessionId === "string" ? msg.agentSessionId : undefined,
        turnId: typeof msg.turnId === "string" ? msg.turnId : undefined,
        createdAt: typeof msg.createdAt === "number" ? msg.createdAt : undefined,
        receivedAt: new Date(),
      },
    ];
  });
}

function handleApprovalResolved({ msg }: ChatRealtimeFrame, { setPendingApprovals }: SideEffectScope): void {
  // 按 (uiSessionId, pendingIndex) 匹配移除：pendingIndex 是每会话局部的，
  // 不匹配会话会误删其他会话的同 index 挂起。
  const pendingIndex = msg.pendingIndex;
  if (typeof pendingIndex !== "number") return;
  const resolvedSessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
  setPendingApprovals(prev =>
    prev.filter(
      (a: PendingApproval) =>
        !(a.pendingIndex === pendingIndex && (resolvedSessionId === undefined || a.uiSessionId === resolvedSessionId)),
    ),
  );
}

function handleStatus(
  { msg, sid, isForActiveView }: ChatRealtimeFrame,
  {
    onSessionProcessing,
    setTokenBudget,
    setClaudeStatus,
    setSatiStatus,
    setIsLoading,
    setCanAbortSession,
  }: SideEffectScope,
): void {
  if (msg.text && msg.text !== "token_budget" && msg.text !== "clear_status") {
    onSessionProcessing?.(sid);
  }
  if (!isForActiveView) return;
  if (msg.text === "token_budget" && msg.tokenBudget) {
    setTokenBudget(msg.tokenBudget as Record<string, unknown>);
  } else if (msg.text === "clear_status") {
    setClaudeStatus(null);
    setSatiStatus(null);
  } else if (msg.text) {
    setClaudeStatus({
      text: msg.text,
      tokens: msg.tokens || 0,
      can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
      compactProgress: msg.compactProgress || msg.compact_progress || null,
    });
    setSatiStatus({
      text: msg.text,
      tokens: msg.tokens || 0,
      can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
      compactProgress: msg.compactProgress || msg.compact_progress || null,
      retryProgress: (msg.retryProgress as RetryProgress | undefined) || null,
    });
    setIsLoading(true);
    setCanAbortSession(msg.canInterrupt !== false);
  }
}

function handleCompactBoundary(
  { sid, isForActiveView }: ChatRealtimeFrame,
  { onSessionProcessing, setClaudeStatus, setSatiStatus, setIsLoading, setCanAbortSession }: SideEffectScope,
): void {
  onSessionProcessing?.(sid);
  if (isForActiveView) {
    setClaudeStatus(null);
    setSatiStatus(null);
    setIsLoading(true);
    setCanAbortSession(true);
  }
}

export function createChatRealtimeSideEffects(
  deps: ChatRealtimeHandlerDeps,
): (kind: string, frame: ChatRealtimeFrame) => void {
  const scope: SideEffectScope = {
    ...deps,
    clearActiveTurnUiState: () => {
      deps.setIsLoading(false);
      deps.setCanAbortSession(false);
      deps.setIsAborting(false);
      deps.setClaudeStatus(null);
      deps.setSatiStatus(null);
    },
    refreshSessionFromServer: (sessionId: string) => {
      return deps.sessionStore.refreshFromServer(sessionId, {
        provider: deps.provider,
        projectName: deps.selectedProject?.name,
        projectPath: deps.selectedProject?.fullPath || deps.selectedProject?.path || "",
      });
    },
  };

  const handlers: Record<string, SideEffectHandler> = {
    file_artifacts: handleFileArtifacts,
    session_created: handleSessionCreated,
    complete: handleComplete,
    error: handleError,
    permission_request: handlePermissionRequest,
    permission_cancelled: handlePermissionCancelled,
    approval_pending: handleApprovalPending,
    approval_resolved: handleApprovalResolved,
    status: handleStatus,
    compact_boundary: handleCompactBoundary,
  };

  return (kind, frame) => {
    handlers[kind]?.(frame, scope);
  };
}
