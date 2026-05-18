import {
  flattenToolResultBlockText,
  type CanonicalMessage,
  type CanonicalToolResultBlock,
} from "../../model/index.js";

export type MicroCompactionInput = {
  messages: CanonicalMessage[];
  /** Now() epoch in ms used to determine `idle for X` time-based decisions. */
  nowMs?: number;
  /** Microcompact only kicks in after this many ms of idle (legacy default ~5min). */
  idleMs?: number;
  /** Max bytes per tool_result allowed to remain after rewrite (legacy default ~512). */
  trimToBytes?: number;
};

export type MicroCompactionResult = {
  messages: CanonicalMessage[];
  rewritten: number;
  rewrittenBytes: number;
  toolCallIds: string[];
  appliedTrigger: "time_based" | "skipped";
};

/**
 * Phase 5 microcompact (time-based path only — decision §3.1 #5):
 * directly rewrites tool_result content in older messages so subsequent turns
 * carry less context. Cached / Anthropic `cache_edits` path is intentionally
 * deferred (intentional_difference `context-microcompact-cached`).
 *
 * The "older" cutoff is determined by message index; the legacy time-based
 * heuristic uses elapsed ms but the simple deterministic version drops to
 * "rewrite all but the last `keepLatest` tool_results".
 */
export class MicroCompactionEngine {
  constructor(private readonly options: { keepLatest?: number; trimToBytes?: number } = {}) {}

  apply(input: MicroCompactionInput): MicroCompactionResult {
    const trimToBytes = input.trimToBytes ?? this.options.trimToBytes ?? 1536;
    const keepLatest = this.options.keepLatest ?? 1;
    const toolResultIndices = this.collectToolResultMessageIndices(input.messages);
    if (toolResultIndices.length <= keepLatest) {
      return {
        messages: input.messages,
        rewritten: 0,
        rewrittenBytes: 0,
        toolCallIds: [],
        appliedTrigger: "skipped",
      };
    }

    const rewriteUntil = toolResultIndices[toolResultIndices.length - 1 - keepLatest];
    const rewrittenIds: string[] = [];
    let rewrittenBytes = 0;

    const messages = input.messages.map((message, index) => {
      if (index > rewriteUntil) {
        return message;
      }
      if (message.role !== "user") {
        return message;
      }
      let touched = false;
      const newContent = message.content.map((block) => {
        if (block.type !== "tool_result") {
          return block;
        }
        const flat = flattenToolResultBlockText(block as CanonicalToolResultBlock);
        if (flat.length <= trimToBytes) {
          return block;
        }
        touched = true;
        rewrittenIds.push(block.toolCallId);
        rewrittenBytes += flat.length - trimToBytes;
        return {
          ...block,
          content: [
            {
              type: "text" as const,
              text: `${flat.slice(0, trimToBytes)}\n... (microcompacted, original ${flat.length} bytes)`,
            },
          ],
        };
      });
      return touched ? { ...message, content: newContent } : message;
    });

    return {
      messages,
      rewritten: rewrittenIds.length,
      rewrittenBytes,
      toolCallIds: rewrittenIds,
      appliedTrigger: rewrittenIds.length > 0 ? "time_based" : "skipped",
    };
  }

  private collectToolResultMessageIndices(messages: CanonicalMessage[]): number[] {
    const indices: number[] = [];
    messages.forEach((message, index) => {
      if (message.role === "user" && message.content.some((block) => block.type === "tool_result")) {
        indices.push(index);
      }
    });
    return indices;
  }
}
