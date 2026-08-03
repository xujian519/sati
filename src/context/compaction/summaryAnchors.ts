/**
 * summaryAnchors — extracted from CompactionEngine.ts (compaction summary pipeline).
 */

import {
  flattenToolResultContentText,
  type CanonicalMessage,
  type CanonicalToolResultReferenceBlock,
} from "../../model/index.js";
import { protectedToolNameSet, splitMessagesIntoTurns } from "./protectedContext.js";
import { circularJsonReplacer } from "./summaryFallback.js";

const COMPACT_SUMMARY_ANCHOR_MAX_ITEMS = 12;

const COMPACT_SUMMARY_ANCHOR_MAX_INPUT_CHARS = 2_000;

export const COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS = 1_200;

export const COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS = 600;

const COMPACT_SUMMARY_ANCHOR_MAX_TOTAL_CHARS = 16_000;

type CompactSummaryAnchor = {
  turn: number;
  toolName: string;
  toolCallId: string;
  userRequest?: string;
  input?: string;
  resultPreview?: string;
  resultIsError?: boolean;
  resultReference?: {
    path: string;
    readFilePath?: string;
    originalBytes: number;
    hasMore: boolean;
    mimeType?: string;
    reason?: string;
  };
};

export function buildCompactSummaryAnchors(
  messages: CanonicalMessage[],
  protectedToolNames: Iterable<string>,
): string | undefined {
  const protectedNames = protectedToolNameSet(protectedToolNames);
  if (protectedNames.size === 0) {
    return undefined;
  }

  const anchors: CompactSummaryAnchor[] = [];
  for (const turn of splitMessagesIntoTurns(messages)) {
    const userRequest = truncateForAnchor(visibleUserTextForTurn(turn.messages), COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS);
    const results = collectToolResultsForTurn(turn.messages);
    for (const message of turn.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type !== "tool_call" || !protectedNames.has(block.name)) {
          continue;
        }
        const result = results.get(block.id);
        anchors.push({
          turn: turn.index,
          toolName: block.name,
          toolCallId: block.id,
          ...(userRequest ? { userRequest } : {}),
          ...(block.input !== undefined
            ? { input: stringifyForAnchor(block.input, COMPACT_SUMMARY_ANCHOR_MAX_INPUT_CHARS) }
            : {}),
          ...(result?.preview ? { resultPreview: result.preview } : {}),
          ...(result?.isError !== undefined ? { resultIsError: result.isError } : {}),
          ...(result?.reference ? { resultReference: result.reference } : {}),
        });
      }
    }
  }

  if (anchors.length === 0) {
    return undefined;
  }

  return renderCompactSummaryAnchors(anchors);
}

function collectToolResultsForTurn(messages: CanonicalMessage[]): Map<
  string,
  {
    preview?: string;
    isError?: boolean;
    reference?: CompactSummaryAnchor["resultReference"];
  }
> {
  const results = new Map<
    string,
    {
      preview?: string;
      isError?: boolean;
      reference?: CompactSummaryAnchor["resultReference"];
    }
  >();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") {
        results.set(block.toolCallId, {
          preview: truncateForAnchor(
            flattenToolResultContentText(block.content),
            COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS,
          ),
          ...(block.isError !== undefined ? { isError: block.isError } : {}),
        });
      }
      if (block.type === "tool_result_reference") {
        results.set(block.toolCallId, {
          preview: truncateForAnchor(block.preview, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS),
          ...(block.isError !== undefined ? { isError: block.isError } : {}),
          reference: compactReferenceForAnchor(block),
        });
      }
    }
  }
  return results;
}

function compactReferenceForAnchor(block: CanonicalToolResultReferenceBlock): CompactSummaryAnchor["resultReference"] {
  return {
    path: truncateForAnchor(block.path, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS),
    ...(block.readFilePath
      ? { readFilePath: truncateForAnchor(block.readFilePath, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS) }
      : {}),
    originalBytes: block.originalBytes,
    hasMore: block.hasMore,
    ...(block.mimeType ? { mimeType: block.mimeType } : {}),
    ...(block.reason ? { reason: truncateForAnchor(block.reason, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS) } : {}),
  };
}

function visibleUserTextForTurn(messages: CanonicalMessage[]): string {
  return messages
    .filter(message => message.role === "user")
    .flatMap(message => message.content)
    .filter(block => block.type === "text")
    .map(block => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function renderCompactSummaryAnchors(anchors: CompactSummaryAnchor[]): string {
  const lines = [
    "<compact-summary-anchors>",
    "Each following line is a JSON object with visible facts from one protected tool call.",
  ];
  let charCount = lines.join("\n").length;
  let included = 0;
  const limitedAnchors = anchors.slice(0, COMPACT_SUMMARY_ANCHOR_MAX_ITEMS);

  for (const anchor of limitedAnchors) {
    const line = JSON.stringify(anchor);
    if (charCount + line.length + 1 > COMPACT_SUMMARY_ANCHOR_MAX_TOTAL_CHARS) {
      break;
    }
    lines.push(line);
    charCount += line.length + 1;
    included += 1;
  }

  const omitted = anchors.length - included;
  if (omitted > 0) {
    lines.push(JSON.stringify({ truncated: true, omittedProtectedToolCalls: omitted }));
  }
  lines.push("</compact-summary-anchors>");
  return lines.join("\n");
}

function stringifyForAnchor(value: unknown, maxChars: number): string {
  try {
    return truncateForAnchor(JSON.stringify(value, circularJsonReplacer()), maxChars);
  } catch {
    return truncateForAnchor(String(value), maxChars);
  }
}

export function truncateForAnchor(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}
