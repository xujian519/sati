import { Fragment, useCallback, type ReactNode } from "react";
import type { TFunction } from "i18next";
import type { DiffLine } from "../chat/utils/messageTransforms";
import type { ChatMessage } from "../chat/types/types";
import type { Project, SessionProvider } from "../../types/app";
import MessageRowV2 from "./MessageRowV2";
import { ProcessLiveStatus, StreamingThinkingPreview, type ProcessTraceStep } from "./ProcessTrace";
import { getLiveProcessGroupStep, splitLiveProcessGroupDetailMessages, type LiveProcessGroup } from "./processGrouping";
import { getMessageKey } from "./subagentDetailKeys";

type LiveProcessRendererParams = {
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  showThinking: boolean;
  isProcessExpanded: (processKey: string, defaultExpanded?: boolean) => boolean;
  onProcessExpandedChange: (processKey: string, expanded: boolean) => void;
  liveProcessGroups: LiveProcessGroup[];
  streamingThinkingContent: string | null;
  thinkingStatusStep: ProcessTraceStep;
  t: TFunction<"chat">;
};

export function useLiveProcessGroupRenderers({
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  showThinking,
  isProcessExpanded,
  onProcessExpandedChange,
  liveProcessGroups,
  streamingThinkingContent,
  thinkingStatusStep,
  t,
}: LiveProcessRendererParams): {
  renderLiveProcessGroup: (group: LiveProcessGroup, index: number) => ReactNode;
} {
  const renderLiveProcessDetailMessages = useCallback(
    (detailMessages: ChatMessage[], groupId: string) => {
      return detailMessages.map((message, index) => (
        <MessageRowV2
          key={`${groupId}-${index}-${getMessageKey(message, index)}`}
          message={message}
          prevMessage={index > 0 ? detailMessages[index - 1] : null}
          nextMessage={index < detailMessages.length - 1 ? detailMessages[index + 1] : null}
          provider={provider}
          selectedProject={selectedProject}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          showThinking={showThinking}
          isProcessExpanded={isProcessExpanded}
          onProcessExpandedChange={onProcessExpandedChange}
        />
      ));
    },
    [createDiff, onProcessExpandedChange, isProcessExpanded, onFileOpen, provider, selectedProject, showThinking],
  );

  const renderLiveProcessGroup = useCallback(
    (group: LiveProcessGroup, index: number) => {
      const isLatestGroup = liveProcessGroups[liveProcessGroups.length - 1]?.id === group.id;
      const step = getLiveProcessGroupStep(group, t, group.isRunning && isLatestGroup ? thinkingStatusStep : null);
      const expanded = isProcessExpanded(group.id);
      const { beforeStatusMessages, statusDetailMessages } = splitLiveProcessGroupDetailMessages(group);
      const showStreamingThinkingBeforeStatus = Boolean(streamingThinkingContent && group.isRunning && isLatestGroup);
      return (
        <Fragment key={group.id || `${group.afterOriginalIndex}-${index}`}>
          {expanded && beforeStatusMessages.length > 0 ? (
            <div className="pl-5">
              {renderLiveProcessDetailMessages(beforeStatusMessages, `${group.id}-before-status`)}
            </div>
          ) : null}
          {showStreamingThinkingBeforeStatus ? (
            <div className="pl-5">
              <StreamingThinkingPreview content={streamingThinkingContent!} />
            </div>
          ) : null}
          <ProcessLiveStatus
            step={step}
            compact
            expanded={expanded}
            onExpandedChange={expanded => onProcessExpandedChange(group.id, expanded)}
          >
            {statusDetailMessages.length > 0 ? renderLiveProcessDetailMessages(statusDetailMessages, group.id) : null}
          </ProcessLiveStatus>
        </Fragment>
      );
    },
    [
      onProcessExpandedChange,
      isProcessExpanded,
      liveProcessGroups,
      renderLiveProcessDetailMessages,
      streamingThinkingContent,
      t,
      thinkingStatusStep,
    ],
  );

  return { renderLiveProcessGroup };
}
