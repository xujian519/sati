/**
 * 活跃聊天界面（组合层）。聊天基础层在 ../chat/（v1 目录：hooks/types/tools/
 * constants/utils/view 均为本文件与其子组件复用的活跃代码，非死代码）——
 * 目录名"v1/v2"不代表新旧，chat-v2 仅是组合壳。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTasksSettings } from "../../contexts/TasksSettingsContext";
import { useToast } from "../../contexts/ToastContext";
import type { ChatInterfaceProps, ChatRunMode } from "../chat/types/types";
import { getSessionRequestParams, isReadOnlySession } from "../../types/app";
import { useChatSessionState } from "../chat/hooks/useChatSessionState";
import { useChatRealtimeHandlers } from "../chat/hooks/useChatRealtimeHandlers";
import { useChatComposerState } from "../chat/hooks/useChatComposerState";
import { useSessionStore } from "../../stores/useSessionStore";
import { useSessionWatch } from "../../hooks/useSessionWatch";
import ChatComposerSlot from "./ChatComposerSlot";
import ChatMessagesRegion from "./ChatMessagesRegion";
import ChatWelcomePane from "./ChatWelcomePane";
import { useChatStreamBuffers } from "./chatInterfaceStreamBuffers";
import { useChatProviderControls } from "./chatInterfaceProviderControls";
import { useChatAbortGuard } from "./chatInterfaceAbortGuard";
import { useChatWebSocketReconnect } from "./chatInterfaceReconnect";
import { useChatForkActions } from "./chatInterfaceForkActions";

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

// V2 chat wrapper. Reuses all business-logic hooks from legacy
// `ChatInterface` so streaming, file-mentions, slash commands, permissions,
// ccr_output, task notifications, subagent containers, etc. all keep working
// unchanged. The difference is purely in the rendered UI:
//   · MessagesPaneV2 — markdown row layout, GPT-like reading width
//   · ComposerV2     — card textarea + paperclip/at + arrow-up send
//   · NO provider picker empty state, NO pill bar, NO gradient bubbles

// 协议 1.7：edit-last-turn / regenerate-last-turn 服务端失败原因白名单
//（未命中按 unknown 兜底提示）。
const REWRITE_ERROR_REASONS = new Set([
  "no_last_turn",
  "active_turn",
  "pending_approval",
  "unsupported_content",
  "compact_tail",
  "not_configured",
]);

function ChatInterfaceV2({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  subscribe,
  // latestMessage is intentionally not consumed here — useChatRealtimeHandlers
  // now subscribes to the WebSocket directly so React 18 state batching can't
  // drop intermediate stream_delta events.
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onSessionActivityBump,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  inlineThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  forceWelcome,
  onExitWelcome,
  compact = false,
}: ChatInterfaceProps) {
  const { t } = useTranslation("chat");
  const { tasksEnabled: _tasksEnabled, isTaskMasterInstalled: _isTaskMasterInstalled } = useTasksSettings();
  const sessionIsReadOnly = isReadOnlySession(selectedSession);
  const sessionRequestParams = React.useMemo(() => getSessionRequestParams(selectedSession), [selectedSession]);

  const sessionStore = useSessionStore();
  const { streamBufferRef, streamTimerRef, accumulatedStreamRef, resetStreamingState } = useChatStreamBuffers();
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  const [runMode, setRunMode] = useState<ChatRunMode>("agent");
  const { addToast } = useToast();

  // 协议 1.7：改写失败的 complete 帧带 rewriteError，映射为 i18n toast。
  const handleRewriteError = useCallback(
    (reason: string) => {
      const known = REWRITE_ERROR_REASONS.has(reason) ? reason : "unknown";
      addToast("error", t(`input.rewriteError.${known}`));
    },
    [addToast, t],
  );

  const provider = useChatProviderControls({ selectedSession, runMode, setRunMode });
  const {
    model,
    permissionMode,
    thinkingModeAvailability,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    setPendingApprovals,
    cycleRunMode,
    effectivePermissionMode,
  } = provider;

  const session = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    processingSessions,
    resetStreamingState,
    pendingViewSessionRef,
    sessionStore,
  });
  const {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    canAbortSession,
    setCanAbortSession,
    setIsAborting,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    setClaudeStatus,
    setSatiStatus,
    scrollToBottom,
  } = session;

  const watchedSessionId = selectedSession?.id || currentSessionId || null;
  useSessionWatch({ sessionId: watchedSessionId, ws, sendMessage });

  const composer = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    model,
    runMode,
    permissionMode: effectivePermissionMode,
    basePermissionMode: permissionMode,
    cycleRunMode,
    isLoading,
    canAbortSession,
    tokenBudget,
    thinkingModeAvailability,
    sendMessage,
    subscribe,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onSessionActivityBump,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    clearMessages,
    rewindMessages,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setSatiStatus,
    setIsUserScrolledUp,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    setPendingApprovals,
    referenceOnlyPrompt: t("documentReferences.defaultPrompt", {
      defaultValue: "Please answer based on the document selection I quoted.",
    }) as string,
  });
  const { setInput, textareaRef, handleSubmit, handleAbortSession, beginEditLastTurn, regenerateLastTurn } = composer;

  const handlePlanExecutionApproved = useCallback(() => {
    setRunMode("agent");
  }, []);

  const handleWebSocketReconnect = useChatWebSocketReconnect({
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
  });

  useChatRealtimeHandlers({
    provider: "sati",
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setSatiStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    setPendingApprovals,
    pendingViewSessionRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    onRewriteError: handleRewriteError,
    sessionStore,
    sendMessage,
  });

  const { isAbortPending, handleAbortWithPending } = useChatAbortGuard({
    isLoading,
    canAbortSession,
    currentSessionId,
    selectedSession,
    handleAbortSession,
  });

  const forkActions = useChatForkActions({
    selectedProject,
    selectedSession,
    currentSessionId,
    isLoading,
    sessionIsReadOnly,
    chatMessages,
    textareaRef,
    setRunMode,
    addToast,
    t,
    setInput,
    onNavigateToSession,
    scrollToBottom,
    beginEditLastTurn,
    regenerateLastTurn,
  });

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  // ChatGPT-style empty state. Triggered explicitly via `forceWelcome` and
  // implicitly when nothing has been started yet (no session, no
  // messages, not in the middle of loading). The composer floats in the
  // middle with a welcome headline above it; once the user sends, we drop
  // into the normal layout (composer at bottom, messages on top) on the
  // next render.
  const isWelcomeMode =
    !!forceWelcome || (!selectedSession && !currentSessionId && !isLoadingSessionMessages && chatMessages.length === 0);

  // Fire onExitWelcome the moment the user submits from welcome mode. Wraps
  // handleSubmit so we don't have to thread state through useChatComposerState.
  const wrappedSubmit = useCallback(
    (...args: unknown[]) => {
      if (isWelcomeMode && onExitWelcome) onExitWelcome();
      return (handleSubmit as (...a: unknown[]) => unknown)(...args);
    },
    [handleSubmit, isWelcomeMode, onExitWelcome],
  );

  // The composer is identical in welcome / normal mode — just rendered in a
  // different parent container. Pulled out so we don't drift between the two.
  const composerSlot = (
    <ChatComposerSlot
      sessionIsReadOnly={sessionIsReadOnly}
      t={t}
      isWelcomeMode={isWelcomeMode}
      compact={compact}
      onFileOpen={onFileOpen}
      sendByCtrlEnter={sendByCtrlEnter}
      wrappedSubmit={wrappedSubmit as typeof handleSubmit}
      handleAbortWithPending={handleAbortWithPending}
      isAbortPending={isAbortPending}
      handlePlanExecutionApproved={handlePlanExecutionApproved}
      runMode={runMode}
      setRunMode={setRunMode}
      composer={composer}
      session={session}
      provider={provider}
    />
  );

  if (isWelcomeMode) {
    return <ChatWelcomePane compact={compact} selectedProject={selectedProject} composerSlot={composerSlot} t={t} />;
  }

  return (
    <ChatMessagesRegion
      session={session}
      composer={composer}
      forkActions={forkActions}
      sessionIsReadOnly={sessionIsReadOnly}
      effectivePermissionMode={effectivePermissionMode}
      runMode={runMode}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      sessionStore={sessionStore}
      onFileOpen={onFileOpen}
      onShowSettings={onShowSettings}
      autoExpandTools={autoExpandTools}
      showRawParameters={showRawParameters}
      showThinking={showThinking}
      inlineThinking={inlineThinking}
      handleWebSocketReconnect={handleWebSocketReconnect}
      composerSlot={composerSlot}
    />
  );
}

export default React.memo(ChatInterfaceV2);
