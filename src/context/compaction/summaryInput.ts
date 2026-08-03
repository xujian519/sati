/**
 * summaryInput — extracted from CompactionEngine.ts (compaction summary pipeline).
 */

import { createHash } from "node:crypto";
import {
  flattenToolResultContentText,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type CanonicalToolCallBlock,
  type CanonicalToolResultBlock,
} from "../../model/index.js";
import { collectToolNamesByCallId } from "./protectedContext.js";
import { stripMultimediaFromMessages } from "./stripMultimedia.js";
import {
  COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS,
  COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS,
  truncateForAnchor,
} from "./summaryAnchors.js";

const COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS = 2_000;

const COMPACT_SUMMARY_INPUT_TOOL_RESULT_PREVIEW_CHARS = 800;

const COMPACT_SUMMARY_INPUT_TOOL_RESULT_TAIL_CHARS = 240;

const COMPACT_SUMMARY_INPUT_DUPLICATE_THRESHOLD_CHARS = 320;

const COMPACT_SUMMARY_INPUT_TOOL_CALL_ARG_MAX_CHARS = 2_000;

export function projectMessagesForSummary(messages: CanonicalMessage[]): CanonicalMessage[] {
  const stripped = stripMultimediaFromMessages(messages);
  const toolNamesByCallId = collectToolNamesByCallId(stripped);
  const seenLargeToolResultHashes = new Set<string>();

  return stripped
    .map(message => {
      const content: CanonicalContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === "tool_call") {
          content.push(pruneToolCallForSummary(block));
          continue;
        }
        if (block.type === "tool_result") {
          content.push(pruneToolResultForSummary(block, toolNamesByCallId, seenLargeToolResultHashes));
          continue;
        }
        if (block.type === "tool_result_reference") {
          content.push(pruneToolResultReferenceForSummary(block));
          continue;
        }
        content.push(block);
      }
      return { ...message, content };
    })
    .filter(message => message.content.length > 0);
}

/**
 * The tail normally stays verbatim so the agent can immediately continue its
 * most recent work. A single raw tool result can nevertheless be larger than
 * the entire tail allowance (for example, an unbounded page fetch). In that
 * case keeping it verbatim makes full compaction unable to recover at all.
 *
 * This only affects the in-context replacement transcript. The durable tool
 * result remains available in the session history; the paired call id is also
 * retained so providers continue to receive a valid tool-call sequence.
 */

/**
 * The tail normally stays verbatim so the agent can immediately continue its
 * most recent work. A single raw tool result can nevertheless be larger than
 * the entire tail allowance (for example, an unbounded page fetch). In that
 * case keeping it verbatim makes full compaction unable to recover at all.
 *
 * This only affects the in-context replacement transcript. The durable tool
 * result remains available in the session history; the paired call id is also
 * retained so providers continue to receive a valid tool-call sequence.
 */
export function projectOversizedRetainedToolResults(
  messages: CanonicalMessage[],
  toolNamesByCallId: ReadonlyMap<string, string>,
): CanonicalMessage[] {
  let changed = false;
  const projected = messages.map(message => {
    const content = message.content.map(block => {
      if (block.type !== "tool_result") {
        return block;
      }
      const flattened = flattenToolResultContentText(block.content).trim();
      if (flattened.length <= COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS) {
        return block;
      }
      changed = true;
      const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
      return {
        type: "tool_result" as const,
        toolCallId: block.toolCallId,
        ...(block.isError === true ? { isError: true } : {}),
        content: [
          {
            type: "text" as const,
            text: `${summarizeToolResultForSummary(toolName, block.toolCallId, flattened, block.isError === true)}\n[Full output remains in the durable session transcript.]`,
          },
        ],
      };
    });
    return changed ? { ...message, content } : message;
  });
  return changed ? projected : messages;
}

function pruneToolCallForSummary(block: CanonicalToolCallBlock): CanonicalToolCallBlock {
  return {
    type: "tool_call",
    id: block.id,
    name: block.name,
    input: pruneSummaryInputValue(block.input),
  };
}

function pruneToolResultForSummary(
  block: CanonicalToolResultBlock,
  toolNamesByCallId: ReadonlyMap<string, string>,
  seenLargeToolResultHashes: Set<string>,
): CanonicalToolResultBlock {
  const flattened = flattenToolResultContentText(block.content).trim();
  const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
  const isLarge = flattened.length > COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS;
  const eligibleForDedup = flattened.length > COMPACT_SUMMARY_INPUT_DUPLICATE_THRESHOLD_CHARS;
  const hash = eligibleForDedup ? hashSummaryText(flattened) : undefined;

  if (isLarge && hash && seenLargeToolResultHashes.has(hash)) {
    return {
      type: "tool_result",
      toolCallId: block.toolCallId,
      isError: block.isError,
      content: [
        {
          type: "text",
          text: `[Duplicate tool output omitted for ${toolName} call ${block.toolCallId}. A newer call produced the same large output.]`,
        },
      ],
    };
  }
  if (hash) {
    seenLargeToolResultHashes.add(hash);
  }

  if (!isLarge) {
    return {
      type: "tool_result",
      toolCallId: block.toolCallId,
      isError: block.isError,
      content: block.content,
    };
  }

  return {
    type: "tool_result",
    toolCallId: block.toolCallId,
    isError: block.isError,
    content: [
      {
        type: "text",
        text: summarizeToolResultForSummary(toolName, block.toolCallId, flattened, block.isError === true),
      },
    ],
  };
}

function pruneToolResultReferenceForSummary(
  block: Extract<CanonicalContentBlock, { type: "tool_result_reference" }>,
): Extract<CanonicalContentBlock, { type: "tool_result_reference" }> {
  return {
    ...block,
    path: truncateForAnchor(block.path, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS),
    ...(block.readFilePath
      ? { readFilePath: truncateForAnchor(block.readFilePath, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS) }
      : {}),
    preview: truncateForAnchor(block.preview, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS),
    ...(block.reason ? { reason: truncateForAnchor(block.reason, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS) } : {}),
  };
}

function pruneSummaryInputValue(value: unknown): unknown {
  return pruneSummaryInputValueInner(value, 0, new WeakSet<object>());
}

function pruneSummaryInputValueInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return truncateForSummaryInput(value, COMPACT_SUMMARY_INPUT_TOOL_CALL_ARG_MAX_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= 4) {
    return "[Truncated]";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.slice(0, 20).map(item => pruneSummaryInputValueInner(item, depth + 1, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, child] of Object.entries(value)) {
      if (count >= 20) {
        break;
      }
      out[key] = pruneSummaryInputValueInner(child, depth + 1, seen);
      count += 1;
    }
    return out;
  }
  return truncateForSummaryInput(String(value), COMPACT_SUMMARY_INPUT_TOOL_CALL_ARG_MAX_CHARS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function summarizeToolResultForSummary(
  toolName: string,
  toolCallId: string,
  flattened: string,
  isError: boolean,
): string {
  const normalized = flattened.replace(/\s+/g, " ").trim();
  const preview = summarizeTextPreview(normalized);
  const kind = isError ? "error" : "output";
  return `[${toolName}] ${kind} for call ${toolCallId}: ${preview}`;
}

function summarizeTextPreview(text: string): string {
  if (text.length <= COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  const head = text.slice(0, COMPACT_SUMMARY_INPUT_TOOL_RESULT_PREVIEW_CHARS).trimEnd();
  const tail = text.slice(-COMPACT_SUMMARY_INPUT_TOOL_RESULT_TAIL_CHARS).trimStart();
  return `${head}\n...[truncated]...\n${tail}`;
}

function truncateForSummaryInput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.max(0, maxChars - 16);
  return `${value.slice(0, head).trimEnd()}...[truncated]`;
}

function hashSummaryText(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}
