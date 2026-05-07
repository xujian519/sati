import type { ModelCapabilities } from "./capabilities.js";
import type { CanonicalModelError } from "./errors.js";
import type { MultimodalConstraints } from "./multimodal.js";

export type ModelProtocol = "anthropic" | "openai";

export type CanonicalRole = "user" | "assistant";

export type CanonicalTextBlock = {
  type: "text";
  text: string;
};

export type CanonicalThinkingBlock = {
  type: "thinking";
  text: string;
};

export type CanonicalImageBlock = {
  type: "image";
  source: "base64" | "url";
  data: string;
  mimeType: string;
  bytes?: number;
  detail?: "auto" | "low" | "high";
};

export type CanonicalPdfBlock = {
  type: "pdf";
  source: "base64";
  data: string;
  mimeType: "application/pdf";
  bytes: number;
  pages?: number;
};

export type CanonicalAudioBlock = {
  type: "audio";
  source: "base64" | "url";
  data: string;
  mimeType: string;
  durationSeconds?: number;
};

export type CanonicalToolCall = {
  id: string;
  name: string;
  input: unknown;
  raw?: unknown;
};

export type CanonicalToolCallBlock = CanonicalToolCall & {
  type: "tool_call";
};

export type CanonicalToolResultBlock = {
  type: "tool_result";
  toolCallId: string;
  content: CanonicalTextBlock[];
  isError?: boolean;
  raw?: unknown;
};

export type CanonicalToolResult = CanonicalToolResultBlock;

export type CanonicalContentBlock =
  | CanonicalTextBlock
  | CanonicalThinkingBlock
  | CanonicalImageBlock
  | CanonicalPdfBlock
  | CanonicalAudioBlock
  | CanonicalToolCallBlock
  | CanonicalToolResultBlock;

export type CanonicalMessage = {
  role: CanonicalRole;
  content: CanonicalContentBlock[];
};

export type CanonicalToolSchema = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type CanonicalToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      name: string;
    };

export type CanonicalThinkingConfig = {
  enabled: boolean;
  budgetTokens?: number;
};

export type CanonicalModelRequest = {
  model: string;
  provider: string;
  messages: CanonicalMessage[];
  systemPrompt?: string;
  tools?: CanonicalToolSchema[];
  toolChoice?: CanonicalToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: CanonicalThinkingConfig;
  stream?: boolean;
  metadata?: Record<string, unknown>;
};

export type CanonicalUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
};

export type CanonicalFinishReason =
  | "stop"
  | "length"
  | "tool_call"
  | "content_filter"
  | "error"
  | "unknown";

export type CanonicalModelEvent =
  | { type: "request_started"; provider: string; model: string; metadata?: Record<string, unknown> }
  | { type: "message_start"; role: "assistant"; raw?: unknown }
  | { type: "text_delta"; text: string; raw?: unknown }
  | { type: "thinking_delta"; text: string; raw?: unknown }
  | { type: "tool_call_start"; id: string; name: string; raw?: unknown }
  | { type: "tool_call_delta"; id: string; delta: string; raw?: unknown }
  | { type: "tool_call_end"; toolCall: CanonicalToolCall; raw?: unknown }
  | { type: "message_end"; finishReason: CanonicalFinishReason; raw?: unknown }
  | { type: "usage"; usage: CanonicalUsage; raw?: unknown }
  | { type: "error"; error: CanonicalModelError };

export type CanonicalModelResponse = {
  role: "assistant";
  content: CanonicalContentBlock[];
  usage?: CanonicalUsage;
  finishReason: CanonicalFinishReason;
  raw?: unknown;
};

export type ModelDefinition = {
  id: string;
  displayName?: string;
  capabilities: ModelCapabilities;
  multimodal: MultimodalConstraints;
  aliases?: string[];
  request?: Record<string, unknown>;
};

export type ProviderConfig = {
  id: string;
  protocol: ModelProtocol;
  url: string;
  apiKey: string;
  timeoutMs?: number;
  headers: Record<string, string>;
  retry?: Record<string, unknown>;
  models: Record<string, ModelDefinition>;
};

export type ModelConfig = {
  defaultProvider: string;
  defaultModel: string;
  providers: Record<string, ProviderConfig>;
};
