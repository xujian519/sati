import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalToolCall,
  CanonicalUsage,
  MultimodalConstraints,
} from "../../model/index.js";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionResult,
} from "../../permission/index.js";
import type { AgentRunMode } from "../../agent/protocol/input.js";
import type { SatiToolAuditRecorder } from "../audit/ToolAuditRecorder.js";
import type { SatiElicitationChannel } from "../elicitation/SatiElicitationChannel.js";
import type { SatiEvidenceCollector } from "./evidence.js";
import type { SatiToolInputSchema, SatiToolValidationResult } from "./schema.js";

/**
 * File-history sink used by `edit_file` / `write_file` to backup files
 * before mutation (C4 §6.4 / F1 trackEdit). Wired in by the agent loop
 * when a `FileHistoryStore` is available; absent for stand-alone tool
 * runtimes (tests, scripted invocations) — affected tools tolerate the
 * missing sink and proceed without backups.
 */
export type SatiToolFileHistorySink = {
  trackEdit(filePath: string, messageId: string): Promise<void>;
};

/**
 * Minimal model client surface tools may use to issue secondary model calls
 * (e.g. `agent` subagent prompts, `web_fetch` content extraction). Mirrors
 * `AgentModelRuntime` but lives in the tool protocol to avoid a tool→agent
 * dependency cycle.
 */
export type SatiToolModelClient = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

/**
 * Subagent fork API exposed to the `agent` tool by the AgentLoop. Lives in
 * the tool protocol layer so the tool implementation doesn't reach into
 * `agent/sub/*` directly (which would invert the dependency).
 *
 * `depth` reports the *current* subagent fork depth (0 = top-level agent;
 * each `agent` invocation hands the next-level loop `depth + 1`).
 * `maxSubagentDepth` is the cap (default 1) — the `agent` tool raises
 * `subagent_depth_exceeded` when `depth >= maxSubagentDepth`.
 */
export type SatiSubagentForkApi = {
  depth: number;
  maxSubagentDepth: number;
  listDefinitions(): { id: string; description: string }[];
  isAllowedDefinition(id: string): boolean;
  fork(args: {
    definitionId: string;
    directive: string;
    subagentId: string;
    toolCallId?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{
    markdown: string;
    usage: CanonicalUsage;
    turns: number;
    durationMs: number;
    parsed?: Record<string, string>;
  }>;
};

export type SatiToolKind =
  | "filesystem"
  | "shell"
  | "network"
  | "mcp"
  | "session"
  | "agent"
  | "structured_output"
  | "custom";

/**
 * 工具业务域（引入自 BCIP ToolDomain 的角色感知裁剪设计）。
 * domain 是业务语义维（与 kind 的技术分类维互补）：工具按域注册、
 * 按域裁剪，角色/子代理可通过 visibleDomains 只暴露相关工具，减少模型工具噪音。
 * 未标注 domain 的工具对任何域都可见（向后兼容）。
 */
export type ToolDomain =
  | "filesystem"
  | "shell"
  | "network"
  | "search"
  | "document"
  | "analysis"
  | "drafting"
  | "quality"
  | "patent"
  | "legal"
  | "literature"
  | "agent"
  | "session"
  | "mcp"
  | "custom";

export type SatiToolResultContent =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "image"; mimeType: string; data: string; bytes?: number; detail?: "auto" | "low" | "high" }
  | { type: "pdf"; mimeType: "application/pdf"; data: string; bytes: number; pages?: number }
  | { type: "file"; path: string; mimeType?: string; description?: string };

export type SatiReadFileStateEntry = {
  mtimeMs: number;
  kind: "text" | "image" | "pdf" | "notebook";
  offset?: number;
  limit?: number;
  pages?: string;
};

export type SatiReadFileStateMap = Map<string, SatiReadFileStateEntry>;

export type SatiWriteSnapshotEntry = {
  absolutePath: string;
  mtimeMs: number;
  contentHash: string;
  /** Set when the snapshot was seeded by a ranged read (offset/limit). */
  offset?: number;
  /** Set when the snapshot was seeded by a ranged read (offset/limit). */
  limit?: number;
};

export type SatiWriteSnapshotMap = Map<string, SatiWriteSnapshotEntry>;

export type SatiFileUpdateNotification = {
  absolutePath: string;
  relativePath: string;
  root: string;
  content: string;
  previousContent: string | null;
};

export type SatiFileUpdateNotifier = {
  didChange?(update: SatiFileUpdateNotification): Promise<void> | void;
  didSave?(update: SatiFileUpdateNotification): Promise<void> | void;
};

export type SatiToolSupplementalMessage = {
  role: "user";
  content: SatiToolResultContent[];
  isMeta?: boolean;
};

export type SatiToolExecutionOutput<Output = unknown> = {
  content: SatiToolResultContent[];
  supplementalMessages?: SatiToolSupplementalMessage[];
  data?: Output;
  metadata?: Record<string, unknown>;
};

export type SatiToolAvailability =
  | { ok: true }
  | { ok: false; code: "setup_required" | "unavailable" | "failed_check"; reason: string };

export type SatiToolAvailabilityContext = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Tool progress event emitted via `SatiToolRuntimeContext.progress`.
 * The sink is fire-and-forget — progress events MUST NOT replace the final
 * `tool_result`, MUST NOT enter the durable transcript, and MAY be dropped
 * by the caller without affecting tool correctness.
 */
export type SatiToolProgressEvent = {
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

export type SatiToolProgressSink = (event: SatiToolProgressEvent) => void;

export type SatiTodoItem = {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: string;
};

export type SatiTodoUpdate = {
  id?: string;
  content?: string;
  status?: SatiTodoItem["status"];
  priority?: string;
};

export type SatiTodoDiagnostics = {
  writeCount: number;
  todoCount: number;
  activeCount: number;
  completedCount: number;
  cancelledCount: number;
  largeRewriteCount: number;
  deletedOpenItemCount: number;
  completedWithoutActiveCount: number;
  lastWrite?: {
    mode: "markdown" | "structured";
    merge: boolean;
    reason?: string;
    addedCount: number;
    removedCount: number;
    changedCount: number;
    deletedOpenItemCount: number;
    largeRewrite: boolean;
    allCompleted: boolean;
  };
};

export type SatiTodoWriteHistoryEntry = {
  createdAt: string;
  mode: "markdown" | "structured";
  merge: boolean;
  reason?: string;
  markdown?: string;
  todos: SatiTodoItem[];
  diagnostics: SatiTodoDiagnostics;
};

export type SatiPlanTodoStateSnapshot = {
  approvedPlan?: string;
  requiresInitialization: boolean;
  toolCallsSinceLastTodoWrite: number;
  lastMarkdown?: string;
  todos: SatiTodoItem[];
  activeTodos: SatiTodoItem[];
  todoHistory: SatiTodoWriteHistoryEntry[];
  todoDiagnostics: SatiTodoDiagnostics;
};

export type SatiPlanTodoStateHandle = {
  getSnapshot(): SatiPlanTodoStateSnapshot;
  markPlanApproved(plan: string): void;
  recordTodoWrite(markdown: string, todos: SatiTodoItem[], options?: { reason?: string }): SatiTodoItem[];
  writeTodos(
    todos: SatiTodoUpdate[],
    options?: { markdown?: string; merge?: boolean; reason?: string },
  ): SatiTodoItem[];
  markToolProgressChanged(toolName: string): void;
  buildPromptAddendum(): string | undefined;
  blockingMessageFor(toolName: string, isReadOnly: boolean): string | undefined;
};

export type SatiToolRuntimeContext = {
  sessionId: string;
  turnId: string;
  cwd: string;
  abortSignal?: AbortSignal;
  subagentTimeoutMs?: number;
  /** The tool call ID assigned by the model for the current invocation. */
  currentToolCallId?: string;
  /**
   * Optional model/provider-specific aliases for emitted tool names. These are
   * used only when the emitted name is not already registered.
   */
  toolAliases?: Record<string, string>;
  permissionMode: PermissionMode;
  permissionContext: PermissionContext;
  auditRecorder?: SatiToolAuditRecorder;
  /**
   * 证据收集器（可选）：每次工具执行后由 ToolRuntime 调用（成功/失败均记录），
   * 供证据闭环（EvidenceSpan 账本）自动收集。未注入时零开销。
   */
  evidenceCollector?: SatiEvidenceCollector;
  /**
   * The final allow decision for the current tool call, populated by
   * ToolRuntime after permission checks pass and before tool execution.
   * Direct tool invocations leave this unset.
   */
  currentPermissionDecision?: Extract<PermissionDecision, { type: "allow" }>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  /**
   * True when the caller routes tool results through a context runtime that
   * implements `applyToolResults` (i.e. a `ToolResultBudget` spill layer).
   * The runtime then replaces oversized results with persisted references, so
   * `ToolRuntime` must NOT truncate the original content here — the spill
   * body must stay intact. When absent/false, `ToolRuntime` applies the
   * `maxResultBytes` head/tail truncation itself as a fallback for direct
   * call paths with no spill layer.
   */
  spillLayerActive?: boolean;
  runMode?: AgentRunMode;
  /**
   * Optional streaming progress sink. Tools that produce incremental output
   * (e.g. `bash` stdout/stderr chunks) can call this to emit progress events
   * before the final result lands. Absent by default; callers opt in by
   * supplying a sink.
   */
  progress?: SatiToolProgressSink;
  /**
   * Optional model client for tools that need to issue secondary model calls
   * (e.g. `agent` subagent prompts, `web_fetch` content extraction). Absent
   * when the caller didn't provide one — affected tools must report
   * `unsupported_tool` with a clear hint instead of failing silently.
   */
  model?: SatiToolModelClient;
  /**
   * Optional user-elicitation channel used by `ask_user_question` and any
   * tool that requests a synchronous user answer. The host (Gateway / TUI /
   * CLI / Feishu) wires this in. Absent when no UI is connected; affected
   * tools must report `unsupported_tool`.
   */
  elicitation?: SatiElicitationChannel;
  /**
   * Optional file-history sink (C4). When provided, `edit_file` /
   * `write_file` call `trackEdit(filePath, messageId)` *before* mutating,
   * so a later `sati rewind` can restore the prior content. Absent
   * for stand-alone runtimes; tools tolerate the absence by simply
   * skipping backup capture (intentional — never block the edit on
   * snapshot infrastructure).
   */
  fileHistory?: SatiToolFileHistorySink;
  /**
   * Optional opaque "message id" the file-history sink uses to group
   * snapshots. Set by the agent loop per user turn (typically the user
   * message UUID). When `fileHistory` is set but `messageId` is missing,
   * tools fall back to `turnId` so trackEdit still runs.
   */
  messageId?: string;
  /**
   * Subagent fork depth (C2 §6.2 / S?). Top-level agent runs at depth 0;
   * subagent forks pass `depth + 1`. The `agent` tool throws
   * `subagent_depth_exceeded` when invoked at `depth >= maxSubagentDepth`
   * (default 1, blocking nested forks). Absent → treated as 0.
   */
  subagentDepth?: number;
  /**
   * Subagent fork API (C2 §6.2). Wired in by the AgentLoop when the parent
   * supports forking; absent for stand-alone tool runtimes (tests). When
   * absent, the `agent` tool falls back to the legacy single-shot model
   * call so unit tests still work.
   */
  subagent?: SatiSubagentForkApi;
  /**
   * Plan directory handle for plan-mode tools (`enter_plan_mode` /
   * `exit_plan_mode`). When plan mode is active the model may create and
   * edit markdown files under this directory, then submit one explicitly
   * via `exit_plan_mode(plan_file_path)`. Absent when PlanFileManager is
   * not configured (e.g. headless / test runtimes).
   */
  planDirectory?: {
    path: string;
    resolve(filePath: string): string | undefined;
    read(filePath: string): string | undefined;
  };
  /**
   * Optional session-scoped todo state used by plan execution flows. The
   * `todo_write` tool records checklist updates here; the runtime can enforce
   * that side-effecting tools do not run before the checklist is initialized
   * or refreshed after progress changes.
   */
  planTodo?: SatiPlanTodoStateHandle;
  /**
   * Multimodal constraints of the model driving this agent session.
   * Absent when the model config doesn't declare multimodal capabilities
   * (text-only). Tools use this to decide whether to return rich content
   * (e.g. base64 images) or a text-only fallback description.
   */
  modelMultimodal?: MultimodalConstraints;
  /**
   * Current max output tokens for this session's model. Surfaced in
   * validation error hints so the model can reason about output budget
   * when planning multi-step writes.
   */
  maxOutputTokens?: number;
  /**
   * True when the model's response was truncated due to output token limit
   * (finishReason === "length"). Tools use this to produce accurate error
   * messages — e.g. distinguishing "parameter missing because output was
   * truncated" from "model failed to provide required parameter".
   */
  outputTruncated?: boolean;
  /**
   * Optional recursive tool executor used by higher-level tools such as
   * `execute_code` to dispatch nested tool calls through the same ToolRuntime
   * permission, lifecycle, audit, and result-limiting path as normal model
   * tool calls. Hosts that execute tools directly may omit this; dependent
   * tools report `unsupported_tool` instead of bypassing safety checks.
   */
  executeTool?: (
    call: SatiToolCall,
    contextPatch?: Partial<SatiToolRuntimeContext>,
  ) => Promise<import("./result.js").SatiToolResult>;
  /**
   * Optional session-scoped cache for read_file de-duplication. The agent loop
   * keeps the map stable across turns so repeated reads of an unchanged file
   * can return a lightweight stub instead of re-injecting the full payload.
   */
  readFileState?: SatiReadFileStateMap;
  /**
   * Session-scoped exact file paths that read_file may read even when they are
   * outside the workspace. Used for registered IM attachments only.
   */
  allowedReadFiles?: string[];
  /**
   * Optional session-scoped map of full-text reads that may authorize
   * subsequent write_file overwrites. Only complete text reads populate this.
   */
  writeSnapshots?: SatiWriteSnapshotMap;
  /**
   * Optional sink that propagates successful file writes to host integrations
   * such as LSP bridges or editor diff views.
   */
  fileUpdateNotifier?: SatiFileUpdateNotifier;
};

export type SatiToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  aliases?: string[];
  title?: string;
  description: string;
  kind: SatiToolKind;
  /** 业务域（可选；未标注对任何域可见，见 ToolDomain 说明）。 */
  domain?: ToolDomain;
  inputSchema: SatiToolInputSchema;
  outputSchema?: Record<string, unknown>;
  /**
   * 合作式执行预算（阶段四 T6.1）：调度层在 ToolRuntime.execute 把 deadline
   * 熔合进执行 signal，到期按 TOOL_TIMEOUT 归一。忽略 signal 的工具无法被
   * 硬杀，仅能在其返回后判定超时。
   */
  timeoutMs?: number;
  maxResultBytes?: number;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  isDestructive?(input: Input): boolean;
  requiresUserInteraction?(input: Input): boolean;
  isOpenWorld?(input: Input): boolean;
  validateInput?(input: Input, context: SatiToolRuntimeContext): Promise<SatiToolValidationResult>;
  checkAvailability?(context: SatiToolAvailabilityContext): SatiToolAvailability | Promise<SatiToolAvailability>;
  checkPermissions?(input: Input, context: SatiToolRuntimeContext): Promise<PermissionResult>;
  execute(input: Input, context: SatiToolRuntimeContext): Promise<SatiToolExecutionOutput<Output>>;
};

export type SatiToolCall = CanonicalToolCall;
