import type { ChatMessage } from "../../chat/types/types";

export function hasAssistantBody(message: ChatMessage, contentDisplayText: string): boolean {
  const hasAssistantProse = contentDisplayText.trim().length > 0;
  const assistantArtifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
  const showStreamingCursor = Boolean(message.isStreaming && !contentDisplayText);
  return hasAssistantProse || showStreamingCursor || assistantArtifacts.length > 0;
}
