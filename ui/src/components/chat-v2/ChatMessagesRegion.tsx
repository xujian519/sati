import type React from "react";
import type { ChatInterfaceProps, ChatRunMode, Provider } from "../chat/types/types";
import type { Project, ProjectSession } from "../../types/app";
import type { SessionStore } from "../../stores/useSessionStore";
import type { useChatSessionState } from "../chat/hooks/useChatSessionState";
import type { useChatComposerState } from "../chat/hooks/useChatComposerState";
import type { useChatForkActions } from "./chatInterfaceForkActions";
import MessagesPaneV2 from "./MessagesPaneV2";

type ChatSession = ReturnType<typeof useChatSessionState>;
type Composer = ReturnType<typeof useChatComposerState>;
type ForkActions = ReturnType<typeof useChatForkActions>;

export type ChatMessagesRegionProps = {
  session: ChatSession;
  composer: Composer;
  forkActions: ForkActions;
  sessionIsReadOnly: boolean;
  effectivePermissionMode: string;
  runMode: ChatRunMode;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  sessionStore: SessionStore;
  onFileOpen: ChatInterfaceProps["onFileOpen"];
  onShowSettings: ChatInterfaceProps["onShowSettings"];
  autoExpandTools: ChatInterfaceProps["autoExpandTools"];
  showRawParameters: ChatInterfaceProps["showRawParameters"];
  showThinking: ChatInterfaceProps["showThinking"];
  inlineThinking: ChatInterfaceProps["inlineThinking"];
  handleWebSocketReconnect: () => Promise<void>;
  composerSlot: React.ReactNode;
};

/**
 * 消息区（#646 B2.6）：MessagesPaneV2 的 props 接线与 composerSlot 的落位。
 * 外层 grid 容器、DOM 结构与全部 props 表达式与搬迁前一致；`forkActions`
 * 内的 `forkDisabled` 由调用方保证已展开为 `isForkPending`。
 */
export default function ChatMessagesRegion({
  session,
  composer,
  forkActions,
  sessionIsReadOnly,
  effectivePermissionMode,
  runMode,
  selectedProject,
  selectedSession,
  sessionStore,
  onFileOpen,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  inlineThinking,
  handleWebSocketReconnect,
  composerSlot,
}: ChatMessagesRegionProps) {
  const {
    scrollContainerRef,
    handleScroll,
    isLoadingSessionMessages,
    sessionLoadError,
    chatMessages,
    activityMessages,
    visibleMessages,
    visibleMessageCount,
    hasMoreMessages,
    totalMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    createDiff,
    isLoading,
    claudeStatus,
    satiStatus,
  } = session;
  const { setInput, handleGrantSessionToolPermission } = composer;
  const { isForkPending, handleFork, handleEditLastUserMessage, handleRegenerateLastTurn } = forkActions;

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-white dark:bg-neutral-950">
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        onWheel={handleScroll}
        onTouchMove={handleScroll}
        isLoadingSessionMessages={isLoadingSessionMessages}
        sessionLoadError={sessionLoadError}
        onRetrySessionLoad={handleWebSocketReconnect}
        chatMessages={chatMessages}
        activityMessages={activityMessages}
        visibleMessages={visibleMessages}
        visibleMessageCount={visibleMessageCount}
        hasMoreMessages={hasMoreMessages}
        totalMessages={totalMessages}
        loadEarlierMessages={loadEarlierMessages}
        loadAllMessages={loadAllMessages}
        allMessagesLoaded={allMessagesLoaded}
        provider={"sati" as Provider}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        onShowSettings={onShowSettings}
        onGrantSessionToolPermission={handleGrantSessionToolPermission}
        autoExpandTools={autoExpandTools}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
        inlineThinking={inlineThinking}
        setInput={setInput}
        isAssistantWorking={isLoading}
        workingStatus={claudeStatus || satiStatus}
        runMode={runMode}
        planModeActive={effectivePermissionMode === "plan"}
        sessionStore={sessionStore}
        onFork={sessionIsReadOnly ? undefined : handleFork}
        forkDisabled={isForkPending}
        onEditLastUserMessage={sessionIsReadOnly ? undefined : handleEditLastUserMessage}
        onRegenerateLastTurn={sessionIsReadOnly ? undefined : handleRegenerateLastTurn}
      />
      {composerSlot}
    </div>
  );
}
