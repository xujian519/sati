import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalToolCall,
} from "../../model/index.js";
import type {
  PermissionContext,
  PermissionMode,
  PermissionResult,
} from "../../permission/index.js";
import type { PolitDeckToolAuditRecorder } from "../audit/ToolAuditRecorder.js";
import type { PolitDeckToolInputSchema, PolitDeckToolValidationResult } from "./schema.js";

/**
 * Minimal model client surface tools may use to issue secondary model calls
 * (e.g. `agent` subagent prompts, `web_fetch` content extraction). Mirrors
 * `AgentModelRuntime` but lives in the tool protocol to avoid a tool→agent
 * dependency cycle.
 */
export type PolitDeckToolModelClient = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

export type PolitDeckToolKind =
  | "filesystem"
  | "shell"
  | "network"
  | "mcp"
  | "session"
  | "agent"
  | "structured_output"
  | "custom";

export type PolitDeckToolResultContent =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "image"; mimeType: string; data: string }
  | { type: "file"; path: string; mimeType?: string; description?: string };

export type PolitDeckToolExecutionOutput<Output = unknown> = {
  content: PolitDeckToolResultContent[];
  data?: Output;
  metadata?: Record<string, unknown>;
};

/**
 * Tool progress event emitted via `PolitDeckToolRuntimeContext.progress`.
 * The sink is fire-and-forget — progress events MUST NOT replace the final
 * `tool_result`, MUST NOT enter the durable transcript, and MAY be dropped
 * by the caller without affecting tool correctness.
 */
export type PolitDeckToolProgressEvent = {
  type: "tool_progress";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  /** Short human-friendly progress message (e.g. "stdout: ..."). */
  message: string;
  /** Optional payload (chunk text, byte counts, partial output, etc.). */
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type PolitDeckToolProgressSink = (event: PolitDeckToolProgressEvent) => void;

export type PolitDeckToolRuntimeContext = {
  sessionId: string;
  turnId: string;
  cwd: string;
  abortSignal?: AbortSignal;
  permissionMode: PermissionMode;
  permissionContext: PermissionContext;
  auditRecorder?: PolitDeckToolAuditRecorder;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  /**
   * Optional streaming progress sink. Tools that produce incremental output
   * (e.g. `bash` stdout/stderr chunks) can call this to emit progress events
   * before the final result lands. Absent by default; callers opt in by
   * supplying a sink.
   */
  progress?: PolitDeckToolProgressSink;
  /**
   * Optional model client for tools that need to issue secondary model calls
   * (e.g. `agent` subagent prompts, `web_fetch` content extraction). Absent
   * when the caller didn't provide one — affected tools must report
   * `unsupported_tool` with a clear hint instead of failing silently.
   */
  model?: PolitDeckToolModelClient;
};

export type PolitDeckToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  aliases?: string[];
  title?: string;
  description: string;
  kind: PolitDeckToolKind;
  inputSchema: PolitDeckToolInputSchema;
  outputSchema?: Record<string, unknown>;
  maxResultBytes?: number;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  isDestructive?(input: Input): boolean;
  requiresUserInteraction?(input: Input): boolean;
  isOpenWorld?(input: Input): boolean;
  validateInput?(input: Input, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolValidationResult>;
  checkPermissions?(input: Input, context: PolitDeckToolRuntimeContext): Promise<PermissionResult>;
  execute(input: Input, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolExecutionOutput<Output>>;
};

export type PolitDeckToolCall = CanonicalToolCall;
