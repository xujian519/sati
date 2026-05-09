import type { CanonicalToolResultBlock } from "../../model/index.js";
import type { PilotDeckToolError } from "./errors.js";
import type { PilotDeckToolResultContent } from "./types.js";

export type PilotDeckToolSuccessResult = {
  type: "success";
  toolCallId: string;
  toolName: string;
  content: PilotDeckToolResultContent[];
  data?: unknown;
  metadata?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
};

export type PilotDeckToolErrorResult = {
  type: "error";
  toolCallId: string;
  toolName: string;
  error: PilotDeckToolError;
  content: PilotDeckToolResultContent[];
  metadata?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
};

export type PilotDeckToolResult = PilotDeckToolSuccessResult | PilotDeckToolErrorResult;

export type PilotDeckToolResultSizeMetadata = {
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  persistedPath?: string;
};

const EMPTY_TOOL_OUTPUT = "Tool completed with no output.";

export function contentToText(content: PilotDeckToolResultContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "json":
      return JSON.stringify(content.value);
    case "image":
      return `[Image: ${content.mimeType}, ${content.data.length} base64 characters]`;
    case "file":
      return `[File: ${content.path}${content.mimeType ? `, ${content.mimeType}` : ""}${
        content.description ? `, ${content.description}` : ""
      }]`;
  }
}

export function toCanonicalToolResultBlock(result: PilotDeckToolResult): CanonicalToolResultBlock {
  const textBlocks = result.content.map((item) => ({
    type: "text" as const,
    text: contentToText(item),
  }));

  return {
    type: "tool_result",
    toolCallId: result.toolCallId,
    isError: result.type === "error" || undefined,
    content: textBlocks.length > 0 ? textBlocks : [{ type: "text", text: EMPTY_TOOL_OUTPUT }],
    raw: result,
  };
}

export function estimateResultContentBytes(content: PilotDeckToolResultContent[]): number {
  return Buffer.byteLength(content.map(contentToText).join("\n"), "utf8");
}

export function applyResultSizeLimit(
  content: PilotDeckToolResultContent[],
  maxBytes: number | undefined,
): { content: PilotDeckToolResultContent[]; metadata?: PilotDeckToolResultSizeMetadata } {
  if (maxBytes === undefined || maxBytes < 0) {
    return { content };
  }

  const originalBytes = estimateResultContentBytes(content);
  if (originalBytes <= maxBytes) {
    return { content };
  }

  const suffix = "\n[Tool output truncated.]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = Math.max(0, maxBytes - suffixBytes);
  const text = content.map(contentToText).join("\n");
  const truncatedText = truncateUtf8(text, budget) + suffix;
  const returnedBytes = Buffer.byteLength(truncatedText, "utf8");

  return {
    content: [{ type: "text", text: truncatedText }],
    metadata: {
      truncated: true,
      originalBytes,
      returnedBytes,
    },
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}
