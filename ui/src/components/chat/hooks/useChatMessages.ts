/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from "../../../stores/useSessionStore";
import type { ChatMessage, CompactBoundaryShadowedMessage, SubagentChildTool } from "../types/types";
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from "../utils/chatFormatting";
import { parseUserAttachmentNote } from "../utils/attachmentNotes";
import { asRecord } from "../../../utils/unknown";

// Per-message conversion cache keyed by NormalizedMessage reference.
// When patchMergedStreamingMessage creates a new object for the streaming
// message, only THAT entry misses — all other messages hit the cache,
// preventing expensive re-creation of ChatMessage objects that would bust
// memo(MessageRowV2) for every message in the session.
const msgConversionCache = new WeakMap<NormalizedMessage, ChatMessage | null>();

type ConvertSingleMessageOptions = {
  preserveEmptyAssistantShell?: boolean;
};

function normalizeAssistantText(content: string): string {
  let text = decodeHtmlEntities(content);
  text = unescapeWithMathProtection(text);
  return formatUsageLimitText(text);
}

function isEmptyAssistantTextMessage(msg: NormalizedMessage): boolean {
  if (msg.kind !== "text" || msg.role !== "assistant") {
    return false;
  }
  return normalizeAssistantText(msg.content || "").trim().length === 0;
}

function isNonRenderableTransportMessage(msg: NormalizedMessage): boolean {
  return (
    msg.kind === "tool_result" ||
    msg.kind === "stream_end" ||
    msg.kind === "complete" ||
    msg.kind === "status" ||
    msg.kind === "permission_request" ||
    msg.kind === "permission_cancelled" ||
    msg.kind === "session_created"
  );
}

function findNeighborRenderableMessage(
  messages: NormalizedMessage[],
  index: number,
  direction: -1 | 1,
): NormalizedMessage | null {
  for (let i = index + direction; i >= 0 && i < messages.length; i += direction) {
    const msg = messages[i];
    if (!msg || isNonRenderableTransportMessage(msg)) {
      continue;
    }
    return msg;
  }
  return null;
}

function shouldPreserveEmptyAssistantShell(messages: NormalizedMessage[], index: number): boolean {
  const msg = messages[index];
  if (!msg || !isEmptyAssistantTextMessage(msg)) {
    return false;
  }

  const previous = findNeighborRenderableMessage(messages, index, -1);
  const next = findNeighborRenderableMessage(messages, index, 1);
  return previous?.kind === "tool_use" || next?.kind === "tool_use";
}

/**
 * 从 compact_boundary 消息的 compactMetadata（透传的 WebMessage payload）
 * 提取被遮蔽消息的索引范围与原文列表，供历史回看展开。
 */
function extractCompactBoundaryShadowed(compactMetadata: unknown): {
  shadowedRanges?: Array<{ fromIndex: number; toIndex: number }>;
  shadowedMessages?: ChatMessage["shadowedMessages"];
  shadowedDiagnostics?: ChatMessage["shadowedDiagnostics"];
} {
  const meta = asRecord(compactMetadata);
  if (!meta) {
    return {};
  }
  const result: {
    shadowedRanges?: Array<{ fromIndex: number; toIndex: number }>;
    shadowedMessages?: ChatMessage["shadowedMessages"];
    shadowedDiagnostics?: ChatMessage["shadowedDiagnostics"];
  } = {};
  const ranges = meta.shadowedRanges;
  if (
    Array.isArray(ranges) &&
    ranges.every(
      range =>
        asRecord(range) &&
        typeof (range as { fromIndex?: unknown }).fromIndex === "number" &&
        typeof (range as { toIndex?: unknown }).toIndex === "number",
    )
  ) {
    result.shadowedRanges = ranges as Array<{ fromIndex: number; toIndex: number }>;
  }
  const diagnostics = meta.shadowedDiagnostics;
  if (
    Array.isArray(diagnostics) &&
    diagnostics.every(diagnostic => {
      const record = asRecord(diagnostic);
      return (
        !!record &&
        typeof record.code === "string" &&
        typeof record.message === "string" &&
        (record.severity === "warning" || record.severity === "error")
      );
    })
  ) {
    result.shadowedDiagnostics = diagnostics as ChatMessage["shadowedDiagnostics"];
  }
  const shadowed = meta.shadowedMessages;
  if (Array.isArray(shadowed)) {
    result.shadowedMessages = shadowed
      .map(message => {
        const record = asRecord(message);
        if (!record || typeof record.kind !== "string") {
          return null;
        }
        const normalized: CompactBoundaryShadowedMessage = {
          id: typeof record.id === "string" ? record.id : undefined,
          kind: record.kind,
          role: typeof record.role === "string" ? record.role : undefined,
          text: typeof record.text === "string" ? record.text : undefined,
          timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
          toolName: typeof record.toolName === "string" ? record.toolName : undefined,
          toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
          ok: typeof record.ok === "boolean" ? record.ok : undefined,
        };
        if (Array.isArray(record.images)) {
          const images = record.images
            .map(image => {
              const imageRecord = asRecord(image);
              if (!imageRecord || typeof imageRecord.data !== "string") {
                return null;
              }
              const entry: { data: string; mimeType?: string; name?: string } = { data: imageRecord.data };
              if (typeof imageRecord.mimeType === "string") {
                entry.mimeType = imageRecord.mimeType;
              }
              if (typeof imageRecord.name === "string") {
                entry.name = imageRecord.name;
              }
              return entry;
            })
            .filter((image): image is { data: string; mimeType?: string; name?: string } => image !== null);
          if (images.length > 0) {
            normalized.images = images;
          }
        }
        return normalized;
      })
      .filter((message): message is CompactBoundaryShadowedMessage => message !== null);
  }
  return result;
}

function convertSingleMessage(
  msg: NormalizedMessage,
  toolResultMap: Map<string, NormalizedMessage>,
  subagentLinks?: Map<string, { subagentId: string; subagentType: string }>,
  options: ConvertSingleMessageOptions = {},
): ChatMessage | null {
  switch (msg.kind) {
    case "text": {
      const parsedUserContent =
        msg.role === "user"
          ? parseUserAttachmentNote(msg.content || "")
          : { content: msg.content || "", attachments: [] };
      const content = parsedUserContent.content;
      const storedAttachments = Array.isArray(msg.attachments)
        ? msg.attachments.filter(attachment => attachment && typeof attachment.name === "string")
        : undefined;
      const userAttachments = [...(storedAttachments || []), ...parsedUserContent.attachments];

      if (msg.role === "user") {
        const userImages = Array.isArray(msg.images)
          ? msg.images.filter(d => typeof d === "string" && d.length > 0).map(d => ({ data: d, name: "" }))
          : undefined;
        if (!content.trim() && userAttachments.length === 0 && (!userImages || userImages.length === 0)) return null;
        return {
          id: msg.id,
          entryId: msg.entryId,
          type: "user",
          content: unescapeWithMathProtection(decodeHtmlEntities(content)),
          timestamp: msg.timestamp,
          ...(msg.forkUnsupportedContent
            ? {
                forkUnsupportedContent: true,
                forkUnsupportedReason: msg.forkUnsupportedReason,
              }
            : {}),
          ...(userImages && userImages.length > 0 ? { images: userImages } : {}),
          ...(userAttachments.length > 0 ? { attachments: userAttachments } : {}),
        };
      } else {
        const text = normalizeAssistantText(content);
        if (!text.trim() && !options.preserveEmptyAssistantShell) return null;
        return {
          id: msg.id,
          entryId: msg.entryId,
          type: "assistant",
          content: text,
          timestamp: msg.timestamp,
        };
      }
    }

    case "file_artifacts":
      if (Array.isArray(msg.artifacts) && msg.artifacts.length > 0) {
        return {
          id: msg.id,
          entryId: msg.entryId,
          type: "assistant",
          content: "",
          artifacts: msg.artifacts,
          timestamp: msg.timestamp,
        };
      }
      return null;

    case "tool_use": {
      const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
      const normalizedToolName = String(msg.toolName || "").toLowerCase();
      const isSubagentContainer = normalizedToolName === "task" || normalizedToolName === "agent";

      const childTools: SubagentChildTool[] = [];
      if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
        for (const tool of msg.subagentTools) {
          const t = tool as Partial<SubagentChildTool>;
          childTools.push({
            toolId: t.toolId ?? "",
            toolName: t.toolName ?? "",
            toolInput: t.toolInput,
            toolResult: t.toolResult ?? null,
            timestamp: new Date(t.timestamp ?? Date.now()),
          });
        }
      }

      const trRecord = asRecord(tr);
      const toolResultImages =
        trRecord && Array.isArray(trRecord.toolResultImages)
          ? (trRecord.toolResultImages as Array<{ data?: unknown; mimeType?: unknown; name?: unknown }>)
              .filter(image => image && typeof image.data === "string" && image.data.length > 0)
              .map(image => ({
                data: image.data as string,
                name: typeof image.name === "string" ? image.name : "",
                ...(typeof image.mimeType === "string" ? { mimeType: image.mimeType } : {}),
              }))
          : undefined;
      const toolResult = trRecord
        ? {
            content: typeof trRecord.content === "string" ? trRecord.content : JSON.stringify(trRecord.content),
            isError: Boolean(trRecord.isError),
            toolUseResult: trRecord.toolUseResult,
            errorCode: typeof trRecord.errorCode === "string" ? trRecord.errorCode : undefined,
            resultPath: trRecord.resultPath,
            ...(toolResultImages && toolResultImages.length > 0 ? { images: toolResultImages } : {}),
            ...(trRecord.planFilePath
              ? {
                  planFilePath: trRecord.planFilePath,
                  planTitle: trRecord.planTitle,
                  planSummary: trRecord.planSummary,
                }
              : {}),
          }
        : null;

      const subagentLink = isSubagentContainer && msg.toolId ? subagentLinks?.get(msg.toolId) : undefined;
      const msgSubagentId = msg.subagentId;

      return {
        id: msg.id,
        type: "assistant",
        content: "",
        timestamp: msg.timestamp,
        isToolUse: true,
        toolName: msg.toolName,
        toolInput: typeof msg.toolInput === "string" ? msg.toolInput : JSON.stringify(msg.toolInput ?? "", null, 2),
        toolId: msg.toolId,
        toolResult,
        isSubagentContainer,
        subagentId: subagentLink?.subagentId || msgSubagentId,
        subagentState: isSubagentContainer
          ? {
              childTools,
              currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
              isComplete: Boolean(toolResult),
              isFailed: Boolean(toolResult?.isError),
            }
          : undefined,
      };
    }

    case "thinking": {
      const thinkingContent = msg.content?.trim() ? msg.content : msg.reasoningContent || "";
      if (thinkingContent.trim()) {
        return {
          id: msg.id,
          type: "assistant",
          content: unescapeWithMathProtection(thinkingContent),
          timestamp: msg.timestamp,
          isThinking: true,
          isStreaming: msg.id.startsWith("__streaming_thinking_"),
        };
      }
      return null;
    }

    case "error":
      return {
        id: msg.id,
        type: "error",
        content: msg.content || "Unknown error",
        timestamp: msg.timestamp,
        ...(msg.userHint ? { userHint: msg.userHint } : {}),
        ...(msg.contentI18n ? { contentI18n: msg.contentI18n } : {}),
        ...(msg.userHintI18n ? { userHintI18n: msg.userHintI18n } : {}),
      };

    case "interactive_prompt":
      return {
        id: msg.id,
        type: "assistant",
        content: msg.content || "",
        timestamp: msg.timestamp,
        isInteractivePrompt: true,
      };

    case "task_notification":
      return {
        id: msg.id,
        type: "assistant",
        content: msg.summary || "Background task update",
        timestamp: msg.timestamp,
        isTaskNotification: true,
        taskStatus: msg.status || "completed",
        taskId: msg.taskId || "",
        outputFile: msg.outputFile || "",
        taskResult: msg.taskResult || "",
      };

    case "interrupted":
      return {
        id: msg.id,
        type: "system",
        content: msg.content || "[Request interrupted by user]",
        timestamp: msg.timestamp,
        isInterruptedNotice: true,
      };

    case "compact_boundary":
      return {
        id: msg.id,
        type: "system",
        content: "Context compacted",
        timestamp: msg.timestamp,
        isCompactBoundary: true,
        compactionId: msg.compactionId,
        compactTrigger: msg.trigger,
        preTokens: msg.preTokens,
        postTokens: msg.postTokens,
        messagesSummarized: msg.messagesSummarized,
        compactLevel: msg.compactLevel,
        compactStage: msg.compactStage,
        compactStageLabel: msg.compactStageLabel,
        ...extractCompactBoundaryShadowed(msg.compactMetadata),
      };

    case "agent_activity":
      return {
        id: msg.id,
        type: "system",
        content: msg.title || "",
        timestamp: msg.timestamp,
        isAgentActivity: true,
        runId: msg.runId,
        activityId: msg.activityId,
        phase: msg.phase,
        state: msg.state,
        title: msg.title,
        detail: msg.detail,
        toolName: msg.toolName,
        toolId: msg.toolId,
        startedAt: msg.startedAt,
        endedAt: msg.endedAt,
        durationMs: msg.durationMs,
        severity: msg.severity,
      };

    case "agent_activity_summary":
      return {
        id: msg.id,
        type: "system",
        content: msg.title || "Process summary",
        timestamp: msg.timestamp,
        isAgentActivitySummary: true,
        runId: msg.runId,
        startedAt: msg.startedAt,
        endedAt: msg.endedAt,
        durationMs: msg.durationMs,
        state: msg.status,
        toolCallCount: msg.toolCallCount,
        toolErrorCount: msg.toolErrorCount,
        ragSearchCount: msg.ragSearchCount,
        editedFileCount: msg.editedFileCount,
        exploredFileCount: msg.exploredFileCount,
        commandCount: msg.commandCount,
        subagentCount: msg.subagentCount,
        compactCount: msg.compactCount,
        thinkingCount: msg.thinkingCount,
        otherToolCount: msg.otherToolCount,
        keySteps: msg.keySteps,
      };

    case "stream_delta":
      if (msg.content) {
        return {
          id: msg.id,
          type: "assistant",
          content: msg.content,
          timestamp: msg.timestamp,
          isStreaming: true,
        };
      }
      return null;

    case "stream_end":
    case "complete":
    case "status":
    case "permission_request":
    case "permission_cancelled":
    case "session_created":
    case "tool_result":
      return null;

    default:
      return null;
  }
}

function convertNormalizedMessages(
  messages: NormalizedMessage[],
  subagentLinks?: Map<string, { subagentId: string; subagentType: string }>,
): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results as ordered queues per toolId so that
  // cross-turn reuse of the same toolId (call_0, call_1, …) pairs correctly.
  const toolResultQueues = new Map<string, NormalizedMessage[]>();
  for (const msg of messages) {
    if (msg.kind === "tool_result" && msg.toolId) {
      const queue = toolResultQueues.get(msg.toolId);
      if (queue) queue.push(msg);
      else toolResultQueues.set(msg.toolId, [msg]);
    }
  }
  const toolResultMap = new Map<string, NormalizedMessage>();

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    // tool_use messages depend on toolResultMap + subagentLinks (external state) so skip cache
    if (msg.kind === "tool_use") {
      if (msg.toolId && !msg.toolResult) {
        const queue = toolResultQueues.get(msg.toolId);
        const next = queue?.shift();
        if (next) toolResultMap.set(msg.toolId, next);
        else toolResultMap.delete(msg.toolId);
      }
      const result = convertSingleMessage(msg, toolResultMap, subagentLinks);
      if (result) converted.push(result);
      continue;
    }

    const preserveEmptyAssistantShell = shouldPreserveEmptyAssistantShell(messages, index);
    const skipCache = isEmptyAssistantTextMessage(msg);

    // All other message types: use WeakMap cache for stable references
    if (!skipCache && msgConversionCache.has(msg)) {
      const cached = msgConversionCache.get(msg);
      if (cached) converted.push(cached);
      continue;
    }

    const result = convertSingleMessage(msg, toolResultMap, undefined, { preserveEmptyAssistantShell });
    if (!skipCache) {
      msgConversionCache.set(msg, result);
    }
    if (result) converted.push(result);
  }

  const grouped: ChatMessage[] = [];
  for (const message of converted) {
    if (!Array.isArray(message.artifacts) || message.artifacts.length === 0) {
      grouped.push(message);
      continue;
    }

    let anchorIndex = -1;
    for (let index = grouped.length - 1; index >= 0; index -= 1) {
      const candidate = grouped[index];
      if (candidate.type === "user") break;
      if (
        candidate.type === "assistant" &&
        !candidate.isToolUse &&
        !candidate.isThinking &&
        !candidate.isAgentActivity &&
        !candidate.isAgentActivitySummary &&
        !candidate.isSubagentContainer &&
        !candidate.isTaskNotification &&
        typeof candidate.content === "string" &&
        candidate.content.trim().length > 0
      ) {
        anchorIndex = index;
        break;
      }
    }

    if (anchorIndex === -1) {
      grouped.push(message);
      continue;
    }
    const anchor = grouped[anchorIndex];
    grouped[anchorIndex] = {
      ...anchor,
      artifacts: [...(anchor.artifacts ?? []), ...message.artifacts],
    };
  }

  return grouped;
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 */
export function normalizedToChatMessages(
  messages: NormalizedMessage[],
  subagentLinks?: Map<string, { subagentId: string; subagentType: string }>,
): ChatMessage[] {
  return convertNormalizedMessages(messages, subagentLinks);
}
