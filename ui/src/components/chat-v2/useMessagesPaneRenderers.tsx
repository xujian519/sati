import { Fragment, useCallback } from "react";
import type { TFunction } from "i18next";
import type { DiffLine } from "../chat/utils/messageTransforms";
import type { ChatMessage, SatiPermissionSuggestion, SessionPermissionGrantResult } from "../chat/types/types";
import type { Project, SessionProvider } from "../../types/app";
import { MeasuredMessageItem } from "./messageVirtualization";
import MessageRowV2 from "./MessageRowV2";
import { ProcessLiveStatus, type ProcessTraceStep } from "./ProcessTrace";
import {
  getLiveProcessGroupStep,
  getWebFetchWaitingStep,
  shouldShowWebFetchWaitingHint,
  splitLiveProcessGroupDetailMessages,
  type LiveProcessGroup,
} from "./processGrouping";
import { countForkCarriedMessages, isRenderableAssistantProse } from "./messagesPaneHelpers";
import { CompletedProcessHeader, LiveProcessHeader } from "./messagesPaneLiveStatus";
import type { KeyedRenderableMessageItem } from "./messagesPaneTypes";

type UseMessagesPaneRenderersOptions = {
  getMessageKey: (message: ChatMessage, index: number) => string;
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (
    suggestion: SatiPermissionSuggestion,
  ) => SessionPermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  isProcessExpanded: (processKey: string, defaultExpanded?: boolean) => boolean;
  handleProcessExpandedChange: (processKey: string, expanded: boolean) => void;
  handleOpenSubagentDetail: (subagentId: string) => void;
  subagentActivityById: Map<string, ChatMessage>;
  subagentThinkingById: Map<string, string>;
  isAssistantWorking: boolean;
  onFork?: (message: ChatMessage, carriedMessageCount: number) => void;
  forkDisabled: boolean;
  onEditLastUserMessage?: (message: ChatMessage) => void;
  onRegenerateLastTurn?: (message: ChatMessage) => void;
  liveProcessGroups: LiveProcessGroup[];
  t: TFunction<"chat">;
  resolvedPlanModeActive: boolean;
  liveStatusStep: ProcessTraceStep;
  keyedMessageItems: KeyedRenderableMessageItem[];
  renderableMessages: ChatMessage[];
  liveProcessGroupsByAnchor: Map<number, LiveProcessGroup[]>;
  liveProcessHeaderIndex: number;
  liveProcessStartedAtMs: number | null;
  nonSubagentLiveActivities: ChatMessage[];
  handleMeasuredItemHeight: (itemKey: string, height: number) => void;
  lastTurnActionIndices: { userIndex: number; assistantIndex: number };
};

export function useMessagesPaneRenderers({
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
}: UseMessagesPaneRenderersOptions) {
  const renderLiveProcessDetailMessages = useCallback(
    (detailMessages: ChatMessage[], groupId: string) =>
      detailMessages.map((message: ChatMessage, index: number) => (
        <MessageRowV2
          key={`${groupId}-${getMessageKey(message, index)}`}
          message={message}
          prevMessage={index > 0 ? detailMessages[index - 1] : null}
          nextMessage={index < detailMessages.length - 1 ? detailMessages[index + 1] : null}
          provider={provider}
          selectedProject={selectedProject}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantSessionToolPermission={onGrantSessionToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          inlineThinking={inlineThinking}
          isProcessExpanded={isProcessExpanded}
          onProcessExpandedChange={handleProcessExpandedChange}
          onOpenSubagentDetail={handleOpenSubagentDetail}
          subagentActivityById={subagentActivityById}
          subagentThinkingById={subagentThinkingById}
          isSessionRunning={isAssistantWorking}
        />
      )),
    [
      autoExpandTools,
      createDiff,
      getMessageKey,
      handleOpenSubagentDetail,
      inlineThinking,
      onFileOpen,
      onGrantSessionToolPermission,
      onShowSettings,
      provider,
      selectedProject,
      subagentActivityById,
      subagentThinkingById,
      isProcessExpanded,
      handleProcessExpandedChange,
      showRawParameters,
      showThinking,
      isAssistantWorking,
    ],
  );

  const renderLiveProcessGroup = useCallback(
    (group: LiveProcessGroup, index: number) => {
      const isLatestGroup = liveProcessGroups[liveProcessGroups.length - 1]?.id === group.id;
      const step = getLiveProcessGroupStep(group, t, group.isRunning && isLatestGroup ? liveStatusStep : null);
      const showWebFetchWaiting = shouldShowWebFetchWaitingHint(group, resolvedPlanModeActive);
      const expanded = isProcessExpanded(group.id);
      const { beforeStatusMessages, statusDetailMessages } = splitLiveProcessGroupDetailMessages(group);
      return (
        <Fragment key={group.id || `${group.afterOriginalIndex}-${index}`}>
          {expanded && beforeStatusMessages.length > 0 ? (
            <div className="pl-5">
              {renderLiveProcessDetailMessages(beforeStatusMessages, `${group.id}-before-status`)}
            </div>
          ) : null}
          <ProcessLiveStatus
            step={step}
            compact
            expanded={expanded}
            onExpandedChange={expanded => handleProcessExpandedChange(group.id, expanded)}
          >
            {statusDetailMessages.length > 0 ? renderLiveProcessDetailMessages(statusDetailMessages, group.id) : null}
          </ProcessLiveStatus>
          {showWebFetchWaiting ? <ProcessLiveStatus step={getWebFetchWaitingStep(group.id, t)} compact /> : null}
        </Fragment>
      );
    },
    [
      handleProcessExpandedChange,
      isProcessExpanded,
      liveProcessGroups,
      liveStatusStep,
      resolvedPlanModeActive,
      renderLiveProcessDetailMessages,
      t,
    ],
  );

  const renderMessageItem = useCallback(
    (item: KeyedRenderableMessageItem) => {
      const previousMessage = item.renderIndex > 0 ? keyedMessageItems[item.renderIndex - 1].message : null;
      const nextMessage =
        item.renderIndex < keyedMessageItems.length - 1 ? keyedMessageItems[item.renderIndex + 1].message : null;
      const isLast = !isAssistantWorking && item.renderIndex === keyedMessageItems.length - 1;
      const forkCarriedMessageCount = countForkCarriedMessages(renderableMessages, item.originalIndex, item.message);
      const anchoredLiveGroups = liveProcessGroupsByAnchor.get(item.originalIndex) || [];
      const rendersLiveHeaderAfterItem = item.renderIndex === liveProcessHeaderIndex - 1;
      const showAssistantActions = (() => {
        if (!isRenderableAssistantProse(item.message)) {
          return false;
        }
        if (isAssistantWorking && item.renderIndex >= liveProcessHeaderIndex) {
          return false;
        }

        for (let index = item.renderIndex + 1; index < keyedMessageItems.length; index += 1) {
          const candidate = keyedMessageItems[index]?.message;
          if (!candidate) {
            continue;
          }
          if (candidate.type === "user") {
            break;
          }
          if (candidate.type === "error") {
            return false;
          }
          if (isRenderableAssistantProse(candidate)) {
            return false;
          }
        }
        return true;
      })();

      return (
        <Fragment key={item.itemKey}>
          {liveProcessHeaderIndex === 0 && item.renderIndex === 0 ? (
            <LiveProcessHeader activities={nonSubagentLiveActivities} startedAtMs={liveProcessStartedAtMs} t={t} />
          ) : null}
          <MeasuredMessageItem
            itemKey={item.itemKey}
            message={item.message}
            isLast={isLast}
            compactBottomSpacing={anchoredLiveGroups.length > 0 || rendersLiveHeaderAfterItem}
            onHeightChange={handleMeasuredItemHeight}
          >
            {item.beforeRunAttachment ? (
              <CompletedProcessHeader durationMs={item.beforeRunAttachment.durationMs} t={t} />
            ) : null}
            <MessageRowV2
              message={item.message}
              prevMessage={previousMessage}
              nextMessage={nextMessage}
              beforeProcessAttachments={item.beforeProcessAttachments}
              afterProcessAttachments={item.afterProcessAttachments}
              provider={provider}
              selectedProject={selectedProject}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantSessionToolPermission={onGrantSessionToolPermission}
              autoExpandTools={autoExpandTools}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              inlineThinking={inlineThinking}
              isProcessExpanded={isProcessExpanded}
              onProcessExpandedChange={handleProcessExpandedChange}
              onOpenSubagentDetail={handleOpenSubagentDetail}
              subagentActivityById={subagentActivityById}
              subagentThinkingById={subagentThinkingById}
              isSessionRunning={isAssistantWorking}
              onFork={onFork}
              forkCarriedMessageCount={forkCarriedMessageCount}
              forkDisabled={forkDisabled}
              showAssistantActions={showAssistantActions}
              onEditLastUserMessage={onEditLastUserMessage}
              onRegenerateLastTurn={onRegenerateLastTurn}
              isLastUserMessage={item.renderIndex === lastTurnActionIndices.userIndex}
              isLastAssistantMessage={item.renderIndex === lastTurnActionIndices.assistantIndex}
            />
            {rendersLiveHeaderAfterItem ? (
              <LiveProcessHeader activities={nonSubagentLiveActivities} startedAtMs={liveProcessStartedAtMs} t={t} />
            ) : null}
            {item.afterRunAttachment ? (
              <CompletedProcessHeader durationMs={item.afterRunAttachment.durationMs} t={t} />
            ) : null}
            {anchoredLiveGroups.length > 0 ? (
              <div className="mt-2 flex min-w-0 flex-col gap-2">{anchoredLiveGroups.map(renderLiveProcessGroup)}</div>
            ) : null}
          </MeasuredMessageItem>
        </Fragment>
      );
    },
    [
      autoExpandTools,
      createDiff,
      handleMeasuredItemHeight,
      handleOpenSubagentDetail,
      handleProcessExpandedChange,
      inlineThinking,
      isProcessExpanded,
      isAssistantWorking,
      keyedMessageItems,
      renderableMessages,
      nonSubagentLiveActivities,
      liveProcessGroupsByAnchor,
      liveProcessHeaderIndex,
      liveProcessStartedAtMs,
      onFileOpen,
      onFork,
      forkDisabled,
      onEditLastUserMessage,
      onRegenerateLastTurn,
      lastTurnActionIndices,
      onGrantSessionToolPermission,
      onShowSettings,
      provider,
      renderLiveProcessGroup,
      selectedProject,
      showRawParameters,
      showThinking,
      subagentActivityById,
      subagentThinkingById,
      t,
    ],
  );

  return { renderLiveProcessDetailMessages, renderLiveProcessGroup, renderMessageItem };
}
