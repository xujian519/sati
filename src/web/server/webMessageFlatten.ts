/**
 * CanonicalMessage → WebMessage 的扁平化投影（从 readSessionMessages.ts 拆出）。
 *
 * 一个 CanonicalMessage 的 content blocks 会拆成一到多个 WebMessage
 * （text / thinking / tool_use / tool_result），相邻 text block 合并。
 * 这是历史会话读取的投影段：核心 replay 仍在 readSessionMessages.ts。
 */

import {
  flattenToolResultBlockText,
  type CanonicalContentBlock,
  type CanonicalImageBlock,
  type CanonicalMessage,
} from "../../model/index.js";
import type { WebMessage, WebMessageKind, WebMessageRole } from "../client/webMessage.js";

export type ProjectionContext = {
  index: number;
  sessionKey: string;
  projectKey?: string;
  now?: () => Date;
  /** Actual transcript entry timestamp — preferred over now(). */
  entryTimestamp?: string;
  /** Transcript entry id for fork targeting. */
  entryId?: string;
  /** True when this entry cannot be fork-prefilled losslessly by the web UI. */
  forkUnsupportedContent?: boolean;
};

/**
 * Flatten a CanonicalMessage's content blocks into one or more WebMessages.
 * Adjacent text blocks within the same canonical message merge.
 *
 * Tool-result images get special handling: when an `image` block immediately
 * follows a `tool_result` block (as produced by `projectToolResults`), the
 * image is attached to that tool_result WebMessage instead of being emitted as
 * a separate user-role text message. Without this, read_file image responses
 * would render as a "user" bubble on the right side of the chat — the
 * canonical wire format requires role=user, but the UI semantics want the
 * picture rendered alongside the tool result on the assistant/tool side.
 */
export function flattenCanonicalMessage(message: CanonicalMessage, context: ProjectionContext): WebMessage[] {
  const stamp = context.entryTimestamp ?? (context.now ?? (() => new Date()))().toISOString();
  const out: WebMessage[] = [];
  const role: WebMessageRole = message.role === "user" ? "user" : "assistant";
  let textBuffer = "";
  let pendingImages: NonNullable<WebMessage["images"]> = [];
  let lastToolResultMessage: WebMessage | undefined;

  const flushText = (): void => {
    if (!textBuffer && pendingImages.length === 0) return;
    out.push({
      id: `${context.sessionKey}-msg-${context.index}-${out.length}`,
      sessionKey: context.sessionKey,
      projectKey: context.projectKey,
      createdAt: stamp,
      provider: "sati",
      role,
      kind: "text",
      text: textBuffer,
      ...(pendingImages.length > 0 ? { images: pendingImages } : {}),
      ...(context.forkUnsupportedContent
        ? {
            payload: {
              forkUnsupportedContent: true,
              forkUnsupportedReason: "This turn contains attachments or media.",
            },
          }
        : {}),
      ...(context.entryId ? { entryId: context.entryId } : {}),
      source: "history",
    });
    textBuffer = "";
    pendingImages = [];
  };

  for (const block of message.content) {
    if (block.type !== "image" && block.type !== "tool_result") {
      // Any other block breaks the tool_result → image association.
      lastToolResultMessage = undefined;
    }
    if (block.type === "image" && lastToolResultMessage && role === "user") {
      const existing = lastToolResultMessage.images ?? [];
      lastToolResultMessage.images = [...existing, toWebMessageImage(block)];
      continue;
    }
    flushBlock(
      block,
      out,
      context,
      stamp,
      role,
      () => {
        flushText();
      },
      chunk => {
        textBuffer += chunk;
      },
      image => {
        pendingImages.push(toWebMessageImage(image));
      },
    );
    if (block.type === "tool_result") {
      lastToolResultMessage = out[out.length - 1];
    }
  }
  flushText();
  return out;
}

function flushBlock(
  block: CanonicalContentBlock,
  out: WebMessage[],
  context: ProjectionContext,
  stamp: string,
  role: WebMessageRole,
  flushText: () => void,
  appendText: (chunk: string) => void,
  appendImage: (image: CanonicalImageBlock) => void,
): void {
  switch (block.type) {
    case "text":
      appendText(block.text);
      return;
    case "thinking":
      flushText();
      out.push({
        id: `${context.sessionKey}-thinking-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "sati",
        role: "assistant",
        kind: "thinking",
        text: block.text,
        source: "history",
      });
      return;
    case "tool_call":
      flushText();
      out.push({
        id: `${context.sessionKey}-tool-${context.index}-${block.id}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "sati",
        role: "tool",
        kind: "tool_use",
        toolCallId: block.id,
        toolName: block.name,
        payload: block.input,
        source: "history",
      });
      return;
    case "tool_result": {
      flushText();
      const resultText = flattenToolResultBlockText(block);
      const errorCode = readToolResultErrorCode(block.raw);
      const toolName = readToolResultToolName(block.raw);
      const planData = readPlanData(block.raw);
      const searchData = readSearchToolData(block.raw);
      const resultImages: NonNullable<WebMessage["images"]> = [];
      for (const sub of block.content) {
        if (sub.type === "image") {
          resultImages.push(toWebMessageImage(sub));
        }
      }
      out.push({
        id: `${context.sessionKey}-tool-${context.index}-${block.toolCallId}-result`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "sati",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ...(toolName ? { toolName } : {}),
        ok: !block.isError,
        text: resultText,
        ...(errorCode ? { errorCode } : {}),
        ...(planData || searchData ? { payload: planData ?? searchData } : {}),
        ...(resultImages.length > 0 ? { images: resultImages } : {}),
        source: "history",
      });
      return;
    }
    case "tool_result_reference":
      flushText();
      out.push({
        id: `${context.sessionKey}-tool-${context.index}-${block.toolCallId}-result-ref`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "sati",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ok: !block.isError,
        text: block.preview,
        resultPath: block.path,
        payload: {
          path: block.path,
          originalBytes: block.originalBytes,
          hasMore: block.hasMore,
          mimeType: block.mimeType,
          reason: block.reason,
        },
        source: "history",
      });
      return;
    case "media_reference":
      flushText();
      out.push({
        id: `${context.sessionKey}-media-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "sati",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ok: true,
        text: block.preview,
        payload: {
          path: block.path,
          originalBytes: block.originalBytes,
          hasMore: block.hasMore,
          mimeType: block.mimeType,
          mediaType: block.mediaType,
          pages: block.pages,
          detail: block.detail,
          reason: block.reason,
        },
        source: "history",
      });
      return;
    case "image":
      if (role === "user") {
        appendImage(block);
        return;
      }
      flushText();
      out.push({
        id: `${context.sessionKey}-attachment-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "sati",
        role,
        kind: "status",
        text: `[${block.type} attachment]`,
        payload: { mimeType: block.mimeType, bytes: "bytes" in block ? block.bytes : undefined },
        source: "history",
      });
      return;
    case "pdf":
    case "audio":
      flushText();
      const kind: WebMessageKind = "status";
      out.push({
        id: `${context.sessionKey}-attachment-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "sati",
        role,
        kind,
        text: `[${block.type} attachment]`,
        payload: { mimeType: block.mimeType, bytes: "bytes" in block ? block.bytes : undefined },
        source: "history",
      });
      return;
  }
}

function toWebMessageImage(block: CanonicalImageBlock): NonNullable<WebMessage["images"]>[number] {
  return {
    data: block.source === "url" ? block.data : `data:${block.mimeType};base64,${block.data}`,
    mimeType: block.mimeType,
  };
}

export function isCompactReplacementMessage(message: CanonicalMessage): boolean {
  return message.metadata?.compactReplacement === true;
}

export function shouldShowCompactReplacementInWeb(message: CanonicalMessage): boolean {
  return !isCompactReplacementMessage(message);
}

function readToolResultErrorCode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const error = (raw as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function readToolResultToolName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const toolName = (raw as { toolName?: unknown }).toolName;
  return typeof toolName === "string" && toolName.length > 0 ? toolName : undefined;
}

function readPlanData(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = (raw as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.planFilePath !== "string") return undefined;
  return {
    planFilePath: d.planFilePath,
    planTitle: d.planTitle,
    planSummary: d.planSummary,
  };
}

function readSearchToolData(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as { toolName?: unknown; data?: unknown };
  if (!isSearchToolName(record.toolName)) return undefined;
  return record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined;
}

function isSearchToolName(name: unknown): boolean {
  const normalized = typeof name === "string" ? name.toLowerCase() : "";
  return normalized === "grep" || normalized === "glob";
}
