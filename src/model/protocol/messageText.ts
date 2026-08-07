import type { CanonicalMessage } from "./canonical.js";

/**
 * Extract all text blocks from a message and join them with newlines.
 *
 * Canonical message→text helper shared by the agent loop and router; lives
 * next to `messageContent` (clone.ts) so message-content utilities are
 * co-located. Moved here from src/agent/loop to avoid it living behind a
 * doom-loop-specific module.
 */
export function textFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");
}
