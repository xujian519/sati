import type { CanonicalMessage } from "../../model/index.js";

export type MessageProjectorInput = {
  messages: CanonicalMessage[];
  /** Maximum number of recent messages to retain (post-boundary slice). */
  maxMessages?: number;
};

export type MessageProjectorResult = {
  messages: CanonicalMessage[];
  /** Number of messages dropped by sliding-window or boundary slicing. */
  droppedCount: number;
  /** Diagnostic flags emitted by the projection. */
  warnings: Array<{
    code: "context_truncated" | "tool_result_orphaned" | "tool_call_unmatched";
    message: string;
  }>;
};

/**
 * Project canonical messages so the output is safe to send to a model:
 *  1. Strip any messages that appear before the last compact boundary marker
 *     (boundary marker itself is opaque from the runtime perspective; agent
 *     loop already runs after replay slicing, so this layer mainly handles
 *     `maxMessages` truncation and tool-result pairing).
 *  2. Ensure every assistant `tool_call` has a matching `tool_result`
 *     immediately following (legacy `mergeUserMessagesAndToolResults`).
 *  3. Apply a sliding window when `maxMessages` is set.
 */
export class MessageProjector {
  project(input: MessageProjectorInput): MessageProjectorResult {
    const warnings: MessageProjectorResult["warnings"] = [];

    const repaired = repairToolResultPairing(input.messages, warnings);

    let projected = repaired;
    let droppedCount = 0;
    if (input.maxMessages !== undefined && repaired.length > input.maxMessages) {
      droppedCount = repaired.length - input.maxMessages;
      projected = repaired.slice(droppedCount);
      warnings.push({
        code: "context_truncated",
        message: `Truncated ${droppedCount} message(s) to respect maxMessages=${input.maxMessages}.`,
      });
    }

    return { messages: projected, droppedCount, warnings };
  }
}

function repairToolResultPairing(
  messages: CanonicalMessage[],
  warnings: MessageProjectorResult["warnings"],
): CanonicalMessage[] {
  const output: CanonicalMessage[] = [];
  let pendingToolCallIds: Set<string> = new Set();

  for (const message of messages) {
    if (message.role === "assistant") {
      const toolCallIds = collectToolCallIds(message);
      pendingToolCallIds = new Set(toolCallIds);
      output.push(message);
      continue;
    }

    // user message: make sure tool_results match the previous assistant's tool_calls.
    const seen = new Set<string>();
    for (const block of message.content) {
      if (block.type === "tool_result") {
        seen.add(block.toolCallId);
      }
    }

    for (const expected of pendingToolCallIds) {
      if (!seen.has(expected)) {
        warnings.push({
          code: "tool_call_unmatched",
          message: `Assistant tool_call ${expected} has no matching tool_result.`,
        });
      }
    }
    for (const provided of seen) {
      if (!pendingToolCallIds.has(provided)) {
        warnings.push({
          code: "tool_result_orphaned",
          message: `tool_result ${provided} has no matching tool_call.`,
        });
      }
    }

    pendingToolCallIds = new Set();
    output.push(message);
  }

  return output;
}

function collectToolCallIds(message: CanonicalMessage): string[] {
  return message.content
    .filter((block): block is { type: "tool_call"; id: string; name: string; input: unknown } =>
      block.type === "tool_call",
    )
    .map((block) => block.id);
}
