import { useMemo } from "react";
import type { ChatMessage, ClaudeWorkStatus, SatiWorkStatus } from "../chat/types/types";
import { getLiveStatusStep } from "./messagesPaneLiveStatus";
import { isRunningActivity, isStreamingThinkingMessage } from "./messagesPaneHelpers";
import type { ProcessTraceStep } from "./ProcessTrace";

type UseLiveStatusViewOptions = {
  subagentActivities: ChatMessage[];
  showThinking: boolean | undefined;
  isAssistantWorking: boolean;
  visibleMessages: ChatMessage[];
  nonSubagentLiveActivities: ChatMessage[];
  workingStatus: ClaudeWorkStatus | SatiWorkStatus | null | undefined;
  hasLiveAssistantContent: boolean;
  hasPendingToolUse: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
};

export function useLiveStatusView({
  subagentActivities,
  showThinking,
  isAssistantWorking,
  visibleMessages,
  nonSubagentLiveActivities,
  workingStatus,
  hasLiveAssistantContent,
  hasPendingToolUse,
  t,
}: UseLiveStatusViewOptions) {
  const runningSubagentActivity = useMemo(
    () => [...subagentActivities].reverse().find(isRunningActivity) || null,
    [subagentActivities],
  );
  const streamingThinkingContent = useMemo(() => {
    if (!showThinking || !isAssistantWorking) {
      return null;
    }
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const msg = visibleMessages[i];
      if (isStreamingThinkingMessage(msg) && typeof msg.content === "string" && msg.content.trim()) {
        return msg.content;
      }
      if (msg.type === "user") break;
    }
    return null;
  }, [showThinking, isAssistantWorking, visibleMessages]);
  const liveStatusStep = useMemo<ProcessTraceStep>(() => {
    if (streamingThinkingContent) {
      return {
        id: "live-thinking",
        title: t("working.thinking", { defaultValue: "thinking" }),
        phase: "thinking",
        state: "running",
      };
    }
    if (runningSubagentActivity) {
      return {
        id: runningSubagentActivity.activityId || runningSubagentActivity.id || "live-subagent-waiting",
        title: t("working.waitingForSubagent", { defaultValue: "Waiting for subagent" }),
        phase: "subagent",
        state: "running",
        toolName: "agent",
      };
    }
    return getLiveStatusStep(nonSubagentLiveActivities, workingStatus, hasLiveAssistantContent, hasPendingToolUse, t);
  }, [
    hasLiveAssistantContent,
    hasPendingToolUse,
    nonSubagentLiveActivities,
    runningSubagentActivity,
    streamingThinkingContent,
    t,
    workingStatus,
  ]);

  return { runningSubagentActivity, streamingThinkingContent, liveStatusStep };
}
