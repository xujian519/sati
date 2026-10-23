import type { ChatMessage } from "../chat/types/types";

export function getMessageKey(message: ChatMessage, index: number): string {
  return String(
    message.id || message.toolId || message.activityId || message.runId || `${message.timestamp || "message"}-${index}`,
  );
}

export function isStreamingSubagentThinkingMessage(message: ChatMessage): boolean {
  return Boolean(message.isThinking && String(message.id || "").startsWith("__subagent_thinking_"));
}
