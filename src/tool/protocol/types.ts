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
import type { PolitDeckElicitationChannel } from "../elicitation/PolitDeckElicitationChannel.js";
import type { PolitDeckToolInputSchema, PolitDeckToolValidationResult } from "./schema.js";

/**
 * File-history sink used by `edit_file` / `write_file` to backup files
 * before mutation (C4 §6.4 / F1 trackEdit). Wired in by the agent loop
 * when a `FileHistoryStore` is available; absent for stand-alone tool
 * runtimes (tests, scripted invocations) — affected tools tolerate the
 * missing sink and proceed without backups.
 */
export type PolitDeckToolFileHistorySink = {
  trackEdit(filePath: string, messageId: string): Promise<void>;
};

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
  /**
   * Optional user-elicitation channel used by `ask_user_question` and any
   * tool that requests a synchronous user answer. The host (Gateway / TUI /
   * CLI / Feishu) wires this in. Absent when no UI is connected; affected
   * tools must report `unsupported_tool`.
   */
  elicitation?: PolitDeckElicitationChannel;
  /**
   * Optional file-history sink (C4). When provided, `edit_file` /
   * `write_file` call `trackEdit(filePath, messageId)` *before* mutating,
   * so a later `politdeck rewind` can restore the prior content. Absent
   * for stand-alone runtimes; tools tolerate the absence by simply
   * skipping backup capture (intentional — never block the edit on
   * snapshot infrastructure).
   */
  fileHistory?: PolitDeckToolFileHistorySink;
  /**
   * Optional opaque "message id" the file-history sink uses to group
   * snapshots. Set by the agent loop per user turn (typically the user
   * message UUID). When `fileHistory` is set but `messageId` is missing,
   * tools fall back to `turnId` so trackEdit still runs.
   */
  messageId?: string;
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
