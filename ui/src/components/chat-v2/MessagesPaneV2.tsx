import { memo } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import { reloadUi } from "../../lib/uiDiagnostics";
import { isReadOnlySession } from "../../types/app";
import { MessagesPanePlaceholder, resolveMessagesPanePlaceholder } from "./MessagesPanePlaceholder";
import ChatHistorySearchBar from "./ChatHistorySearchBar";
import SubagentDetailModal from "./SubagentDetailModal";
import { ProcessLiveStatus, StreamingThinkingPreview } from "./ProcessTrace";
import { LiveProcessHeader } from "./messagesPaneLiveStatus";
import { isForkedChatSession } from "./messagesPaneHelpers";
import { useMessagesPaneInteractionState } from "./useMessagesPaneInteractionState";
import { useSubagentActivityProjection } from "./useSubagentActivityProjection";
import { useRenderableMessageTimeline } from "./useRenderableMessageTimeline";
import { useLiveStatusView } from "./useLiveStatusView";
import { useMessagesPaneRenderers } from "./useMessagesPaneRenderers";
import { useMessagesPaneSearchAndLayout } from "./useMessagesPaneSearchAndLayout";
import type { MessagesPaneV2Props } from "./messagesPaneTypes";

function MessagesPaneV2({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  sessionLoadError,
  onRetrySessionLoad,
  chatMessages,
  activityMessages = [],
  visibleMessages,
  visibleMessageCount,
  hasMoreMessages,
  totalMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  provider,
  selectedProject,
  selectedSession,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantSessionToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
  inlineThinking,
  setInput,
  isAssistantWorking = false,
  workingStatus,
  runMode = "agent",
  planModeActive = false,
  sessionStore,
  onFork,
  forkDisabled = false,
  forkParentSessionTitle = null,
  onEditLastUserMessage,
  onRegenerateLastTurn,
}: MessagesPaneV2Props) {
  const resolvedPlanModeActive = planModeActive || runMode === "plan";
  const { t } = useTranslation("chat");
  // 布局告警文案与 ErrorBoundary 共用 common 命名空间的 uiText 段。
  const { t: tCommon } = useTranslation("common");
  const {
    renderableItemsCacheRef,
    openSubagentId,
    setOpenSubagentId,
    handleOpenSubagentDetail,
    getMessageKey,
    isProcessExpanded,
    handleProcessExpandedChange,
  } = useMessagesPaneInteractionState();

  const sessionId = selectedSession?.id ?? null;
  const projectPath = selectedProject?.fullPath || selectedProject?.path || undefined;

  const suggestedPrompts: string[] = [
    t("emptyChat.prompts.plan", { defaultValue: "Plan a refactor for this project" }),
    t("emptyChat.prompts.summary", { defaultValue: "Summarize recent changes" }),
    t("emptyChat.prompts.review", { defaultValue: "Review the most recent file I touched" }),
  ];
  const isEmpty = !isLoadingSessionMessages && chatMessages.length === 0;
  const hasSessionLoadError = Boolean(!isLoadingSessionMessages && sessionLoadError && chatMessages.length === 0);
  const isNewConversationEmpty = isEmpty && !selectedSession;
  const isExistingConversationEmpty = isEmpty && Boolean(selectedSession) && !hasSessionLoadError;
  const sessionIsReadOnly = isReadOnlySession(selectedSession);

  const panePlaceholderKind = resolveMessagesPanePlaceholder({
    hasSessionLoadError,
    isLoadingSessionMessages,
    messageCount: chatMessages.length,
    isNewConversationEmpty,
    isExistingConversationEmpty,
    isForkedSession: isForkedChatSession(selectedSession),
  });

  const {
    subagentActivities,
    nonSubagentLiveActivities,
    subagentActivityById,
    subagentThinkingById,
    openSubagentActivity,
    isOpenSubagentRunning,
  } = useSubagentActivityProjection({ activityMessages, openSubagentId, sessionId, sessionStore });

  const {
    subagentDetail,
    renderableMessages,
    lastTurnActionIndices,
    liveProcessDetailMessages,
    liveProcessGroups,
    liveProcessGroupsByAnchor,
    keyedMessageItems,
    measuredItemHeights,
    shouldVirtualizeMessages,
    virtualWindow,
    windowedMessageItems,
    handleMeasuredItemHeight,
    liveProcessHeaderIndex,
    liveProcessStartedAtMs,
    hasLiveAssistantContent,
    hasPendingToolUse,
  } = useRenderableMessageTimeline({
    selectedSession,
    openSubagentId,
    sessionId,
    projectPath,
    sessionStore,
    openSubagentActivityState: openSubagentActivity?.state,
    visibleMessages,
    showThinking,
    inlineThinking,
    isAssistantWorking,
    runMode,
    renderableItemsCacheRef,
    getMessageKey,
    scrollContainerRef,
  });

  const { streamingThinkingContent, liveStatusStep } = useLiveStatusView({
    subagentActivities,
    showThinking,
    isAssistantWorking,
    visibleMessages,
    nonSubagentLiveActivities,
    workingStatus,
    hasLiveAssistantContent,
    hasPendingToolUse,
    t,
  });
  const hasOpenEndedLiveProcessGroup = liveProcessGroups.some(group => group.isRunning);
  const shouldRenderBottomLiveStatus = isAssistantWorking && !hasOpenEndedLiveProcessGroup;

  const { renderLiveProcessDetailMessages, renderMessageItem } = useMessagesPaneRenderers({
    getMessageKey,
    provider,
    selectedProject,
    createDiff,
    onFileOpen,
    onShowSettings,
    onGrantSessionToolPermission,
    autoExpandTools,
    showRawParameters,
    showThinking,
    inlineThinking,
    isProcessExpanded,
    handleProcessExpandedChange,
    handleOpenSubagentDetail,
    subagentActivityById,
    subagentThinkingById,
    isAssistantWorking,
    onFork,
    forkDisabled,
    onEditLastUserMessage,
    onRegenerateLastTurn,
    liveProcessGroups,
    t,
    resolvedPlanModeActive,
    liveStatusStep,
    keyedMessageItems,
    renderableMessages,
    liveProcessGroupsByAnchor,
    liveProcessHeaderIndex,
    liveProcessStartedAtMs,
    nonSubagentLiveActivities,
    handleMeasuredItemHeight,
    lastTurnActionIndices,
  });

  const { chatHistorySearch, searchIsRenderedByShell, hasLayoutWarning } = useMessagesPaneSearchAndLayout({
    scrollContainerRef,
    keyedMessageItems,
    measuredItemHeights,
    allMessagesLoaded,
    hasMoreMessages,
    loadAllMessages,
    sessionId,
    virtualWindow,
    isAssistantWorking,
    isLoadingSessionMessages,
    chatMessages,
    shouldVirtualizeMessages,
  });

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {hasLayoutWarning ? (
        <div
          role="alert"
          className="absolute inset-x-4 top-4 z-20 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <span>{tCommon("uiText.chatLayoutError")}</span>
          <button
            type="button"
            onClick={reloadUi}
            className="shrink-0 rounded px-2 py-1 underline underline-offset-2 hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            {tCommon("uiText.reloadInterface")}
          </button>
        </div>
      ) : null}
      {chatHistorySearch.isOpen && !searchIsRenderedByShell ? (
        <ChatHistorySearchBar
          query={chatHistorySearch.query}
          onQueryChange={chatHistorySearch.setQuery}
          matchCount={chatHistorySearch.matches.length}
          activeMatchIndex={chatHistorySearch.activeMatchIndex}
          onPrevious={chatHistorySearch.goToPrevious}
          onNext={chatHistorySearch.goToNext}
          onClose={chatHistorySearch.closeSearch}
          inputRef={chatHistorySearch.inputRef}
        />
      ) : null}
      <div
        ref={scrollContainerRef}
        onWheel={onWheel}
        onTouchMove={onTouchMove}
        className="h-full overflow-x-hidden overflow-y-auto bg-white dark:bg-neutral-950"
      >
        {panePlaceholderKind ? (
          <MessagesPanePlaceholder
            kind={panePlaceholderKind}
            sessionLoadError={sessionLoadError}
            onRetrySessionLoad={onRetrySessionLoad}
            selectedProject={selectedProject}
            suggestedPrompts={suggestedPrompts}
            setInput={setInput}
            selectedSession={selectedSession}
            forkParentSessionTitle={forkParentSessionTitle}
            sessionIsReadOnly={sessionIsReadOnly}
          />
        ) : (
          <div
            className="mx-auto max-w-[860px] px-6 py-10"
            data-virtualized-messages={shouldVirtualizeMessages ? "true" : undefined}
            data-rendered-message-count={windowedMessageItems.length}
            data-total-message-count={keyedMessageItems.length}
          >
            {hasMoreMessages && !allMessagesLoaded ? (
              <div className="mb-8 flex items-center justify-between border-b border-neutral-200 pb-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                <span>
                  {t("session.messages.showingOf", {
                    shown: chatMessages.length,
                    total: totalMessages,
                    defaultValue: `Showing ${chatMessages.length} of ${totalMessages}`,
                  })}
                </span>
                <button
                  type="button"
                  onClick={loadEarlierMessages}
                  className="text-[12px] text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
                >
                  {t("session.messages.loadEarlier", { defaultValue: "Load earlier messages" })}
                </button>
              </div>
            ) : null}

            {!hasMoreMessages && chatMessages.length > visibleMessageCount ? (
              <div className="mb-8 flex items-center justify-between border-b border-neutral-200 pb-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                <span>
                  {t("session.messages.showingLast", {
                    visibleCount: visibleMessageCount,
                    total: chatMessages.length,
                    defaultValue: `Showing last ${visibleMessageCount} of ${chatMessages.length}`,
                  })}
                </span>
                <button
                  type="button"
                  onClick={loadAllMessages}
                  className="text-[12px] text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
                >
                  {t("session.messages.loadAll", { defaultValue: "Load all messages" })}
                </button>
              </div>
            ) : null}

            {isForkedChatSession(selectedSession) ? (
              <div className="mb-6 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
                <GitBranch className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                <span>
                  {t("fork.banner", {
                    parent: forkParentSessionTitle || selectedSession?.parentSessionId || "",
                    defaultValue: `Forked from ${forkParentSessionTitle || selectedSession?.parentSessionId || "parent session"}`,
                  })}
                </span>
              </div>
            ) : null}

            {shouldVirtualizeMessages && virtualWindow.topPadding > 0 ? (
              <div aria-hidden="true" style={{ height: virtualWindow.topPadding }} />
            ) : null}

            {windowedMessageItems.map(renderMessageItem)}

            {shouldVirtualizeMessages && virtualWindow.bottomPadding > 0 ? (
              <div aria-hidden="true" style={{ height: virtualWindow.bottomPadding }} />
            ) : null}

            {isAssistantWorking &&
            liveProcessHeaderIndex === keyedMessageItems.length &&
            keyedMessageItems[liveProcessHeaderIndex - 1]?.message.type !== "user" ? (
              <LiveProcessHeader activities={nonSubagentLiveActivities} startedAtMs={liveProcessStartedAtMs} t={t} />
            ) : null}

            {shouldRenderBottomLiveStatus ? (
              <>
                <ProcessLiveStatus step={liveStatusStep}>
                  {liveProcessDetailMessages.length > 0 && liveProcessGroups.length === 0
                    ? renderLiveProcessDetailMessages(liveProcessDetailMessages, "bottom-live-process")
                    : null}
                </ProcessLiveStatus>
                {!inlineThinking && streamingThinkingContent ? (
                  <StreamingThinkingPreview content={streamingThinkingContent} />
                ) : null}
              </>
            ) : null}
          </div>
        )}

        {openSubagentId ? (
          <SubagentDetailModal
            subagentId={openSubagentId}
            messages={subagentDetail.messages}
            isLoading={subagentDetail.isLoading}
            error={subagentDetail.error}
            provider={provider}
            selectedProject={selectedProject}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            showThinking={showThinking}
            isRunning={isOpenSubagentRunning}
            onClose={() => setOpenSubagentId(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

export default memo(MessagesPaneV2);
