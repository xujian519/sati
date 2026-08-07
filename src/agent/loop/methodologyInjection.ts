import { messageContent, type CanonicalMessage } from "../../model/index.js";

/**
 * Append an optional methodology prompt (from the injected hook) to the system
 * prompt, keyed off the FIRST user text message of the request. No-op when the
 * hook is absent or returns nothing.
 *
 * Keying off the first user message (rather than the last) keeps the
 * methodology stable across the turn: tool results and supplemental
 * messages are projected as later role:"user" messages and would otherwise
 * flip the matched methodology (or drop it) mid-turn, and it keeps the
 * system-prompt prefix stable for prompt caching.
 *
 * Pure function — no class/instance state. Extracted from AgentLoop so the
 * methodology feature can be unit-tested and evolved independently.
 */
export function applyMethodologyInjection(
  systemPrompt: string,
  messages: CanonicalMessage[],
  inject?: (lastUserMessage: string) => string | null,
): string {
  if (!inject) return systemPrompt;
  let firstUserText: string | undefined;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const parts: string[] = [];
    for (const block of messageContent(message)) {
      if (block.type === "text") parts.push(block.text);
    }
    if (parts.length > 0) {
      firstUserText = parts.join("\n");
      break;
    }
  }
  if (firstUserText === undefined) return systemPrompt;
  const addendum = inject(firstUserText);
  if (!addendum) return systemPrompt;
  return `${systemPrompt}\n\n${addendum}`;
}
