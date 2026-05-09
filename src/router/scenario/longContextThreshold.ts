import type { CanonicalMessage } from "../../model/index.js";

const SECOND_PASS_THRESHOLD = 20_000;

export type LongContextHint = {
  /** Pre-computed input token count for the request, when available. */
  tokenCount?: number;
  /** Last observed usage from a previous turn, used as a heuristic. */
  lastUsageInputTokens?: number;
};

export type LongContextDecision = {
  matched: boolean;
  reason?: "token_count" | "last_usage";
};

export function decideLongContext(
  hint: LongContextHint,
  threshold: number | undefined,
  messages: CanonicalMessage[],
): LongContextDecision {
  if (!threshold || threshold <= 0) {
    return { matched: false };
  }

  if (typeof hint.tokenCount === "number" && hint.tokenCount > threshold) {
    return { matched: true, reason: "token_count" };
  }

  if (
    typeof hint.lastUsageInputTokens === "number" &&
    hint.lastUsageInputTokens > threshold &&
    estimateMessageBytes(messages) > SECOND_PASS_THRESHOLD
  ) {
    return { matched: true, reason: "last_usage" };
  }

  return { matched: false };
}

function estimateMessageBytes(messages: CanonicalMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") {
        total += block.text.length;
      } else if (block.type === "tool_result") {
        const text = block.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        total += text.length;
      } else if (block.type === "tool_call") {
        total += JSON.stringify(block.input ?? {}).length;
      }
    }
  }
  return total;
}
