import type { ChatMessage } from "../chat/types/types";
import { isReadOnlySession, type ProjectSession } from "../../types/app";

export function isStreamingThinkingMessage(message: ChatMessage): boolean {
  return Boolean(message.isThinking && String(message.id || "").startsWith("__streaming_thinking_"));
}

export function isRenderableAssistantProse(message: ChatMessage): boolean {
  return (
    message.type === "assistant" &&
    !message.isToolUse &&
    !message.isThinking &&
    !message.isStreaming &&
    !message.isInteractivePrompt &&
    !message.isSubagentContainer &&
    !message.isTaskNotification &&
    !message.isAgentActivity &&
    !message.isAgentActivitySummary &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

export function isSubagentThinkingPlaceholder(message: ChatMessage): boolean {
  const id = String(message.id || "");
  return Boolean(message.isThinking && (id.startsWith("subagent_thinking_") || id.startsWith("__subagent_thinking_")));
}

function countCarriedMessagesBefore(messages: ChatMessage[], originalIndex: number): number {
  return messages
    .slice(0, originalIndex)
    .filter(message => message.type === "user" || message.type === "assistant" || message.isToolUse).length;
}

export function countForkCarriedMessages(messages: ChatMessage[], originalIndex: number, message: ChatMessage): number {
  if (message.type !== "assistant") {
    return message.type === "user" ? countCarriedMessagesBefore(messages, originalIndex) : 0;
  }

  let forkTargetIndex = -1;
  for (let index = originalIndex; index >= 0; index -= 1) {
    if (messages[index]?.type === "user") {
      forkTargetIndex = index;
      break;
    }
  }
  return countCarriedMessagesBefore(messages, forkTargetIndex >= 0 ? forkTargetIndex : originalIndex);
}

export function isForkedChatSession(session: ProjectSession | null): boolean {
  return Boolean(session?.parentSessionId && !isReadOnlySession(session));
}

export function isSubagentActivity(activity: ChatMessage): boolean {
  const activityId = String(activity.activityId || activity.runId || "");
  return activity.phase === "subagent" || activityId.startsWith("subagent:");
}

export function isRunningActivity(activity: ChatMessage): boolean {
  return !["completed", "failed", "cancelled"].includes(String(activity.state || "running"));
}
