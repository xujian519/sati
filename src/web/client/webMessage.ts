/**
 * Web-facing message DTO + reducer.
 *
 * Live `WebGatewayEvent` and historical transcript replays are projected onto
 * the same `WebMessage[]` shape so the React UI does not have to branch on
 * "live vs history" code paths.
 *
 * P2.9（issue #646）：`applyWebGatewayEvent` 的 383 行 switch 改为**按事件种类查表**
 * （WEB_EVENT_HANDLERS）。表为 `WebGatewayEvent` 全种类的 required Record——新增
 * 帧种类时 typecheck 强制处置（帧面静音种类显式写 `ignoreEvent`），不再依赖
 * switch default 的静默面。
 */

import { isVisibleFailureStatusDetail } from "../../status/agentStatus.js";
import type { WebGatewayEvent } from "./protocol.js";

function normalizeToolDisplayName(name: string): string {
  const aliases: Record<string, string> = {
    agent: "Task",
    ask_user_question: "AskUserQuestion",
    bash: "Bash",
    edit_file: "Edit",
    glob: "Glob",
    grep: "Grep",
    read_file: "Read",
    write_file: "Write",
  };
  if (aliases[name]) return aliases[name];
  if (name === "todo_write") return "TodoWrite";
  if (name === "todo_read") return "TodoRead";
  return name;
}

function isReadOnlyModeToolDenyText(text: unknown): "plan_mode_denied" | "ask_mode_denied" | undefined {
  if (typeof text !== "string") return undefined;
  if (/\[PLAN_MODE_VIOLATION\]/i.test(text) || /plan mode denies side-effecting tool\b/i.test(text)) {
    return "plan_mode_denied";
  }
  if (/\[ASK_MODE_VIOLATION\]/i.test(text) || /ask mode denies side-effecting tool\b/i.test(text)) {
    return "ask_mode_denied";
  }
  return undefined;
}

function normalizeToolErrorCode(errorCode: string | undefined, resultPreview: unknown): string | undefined {
  if (errorCode === "plan_mode_violation") return "plan_mode_denied";
  if (errorCode === "ask_mode_violation") return "ask_mode_denied";
  return isReadOnlyModeToolDenyText(resultPreview) ?? errorCode;
}

const ERROR_AGENT_STATUS_EVENTS = new Set([
  "model_empty_response_exhausted",
  "max_turns_reached",
  "max_output_recovery_exhausted",
  "model_request_failed",
  "tool_call_recovery_exhausted",
  "tool_error_loop",
  "lifecycle_blocked",
  "turn_failed",
  "turn_timeout",
  "gateway_submit_failed",
  "session_busy",
  "gateway_bridge_error",
  "gateway_stream_ended_without_completion",
  "web_http_request_failed",
  "project_unavailable",
  "config_invalid",
  "gateway_unavailable",
  "channel_submit_failed",
  "subagent_failed",
  "content_filter_stop",
  "unknown_finish_reason",
]);

const STATUS_AGENT_STATUS_EVENTS = new Set(["structured_output_completed", "turn_aborted"]);

export type WebMessageRole = "user" | "assistant" | "tool" | "system" | "permission" | "error";

export type WebMessageKind =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "permission_request"
  | "elicitation_request"
  | "status"
  | "complete"
  | "interrupted"
  | "error"
  | "structured_output"
  | "compact_boundary"
  | "file_artifacts";

export type WebMessage = {
  id: string;
  sessionKey: string;
  projectKey?: string;
  createdAt: string;
  provider: "sati" | (string & {});
  role: WebMessageRole;
  kind: WebMessageKind;
  toolCallId?: string;
  toolName?: string;
  requestId?: string;
  ok?: boolean;
  text?: string;
  contentI18n?: { key: string; params?: Record<string, unknown> };
  userHintI18n?: { key: string; params?: Record<string, unknown> };
  images?: Array<{
    data: string;
    name?: string;
    mimeType?: string;
  }>;
  artifacts?: import("../../session/artifacts/FileArtifact.js").FileArtifact[];
  /**
   * `SatiToolErrorCode` of the underlying failure when
   * `kind === 'tool_result'` and `ok === false`. Empty for non-error or
   * non-tool-result frames. See `chatPermissions.ts` for how the host UI
   * uses this.
   */
  errorCode?: string;
  resultPath?: string;
  /** UUID of the subagent spawned by this tool_use (agent/Task) call. */
  subagentId?: string;
  payload?: unknown;
  source: "live" | "history";
  finishReason?: string;
  usage?: Record<string, number>;
  /** Transcript entry id when projected from history (used for history fork). */
  entryId?: string;
};

export type WebMessageReducerOptions = {
  sessionKey: string;
  projectKey?: string;
  /** Returns ISO 8601 timestamp; injected for deterministic tests. */
  now?: () => Date;
  /** Generates stable ids; injected for deterministic tests. */
  newId?: () => string;
};

export type WebMessageReducerState = {
  messages: WebMessage[];
  /** Active assistant message id where new text deltas are appended. */
  currentAssistantId?: string;
  /** Active assistant thinking id where thinking deltas are appended. */
  currentThinkingId?: string;
  /** Map toolCallId -> message id so we can flip to tool_result on finish. */
  toolMessageByCallId: Record<string, string>;
  /** True after this turn has already shown a visible failure status. */
  hasVisibleFailureStatus: boolean;
};

export function createWebMessageReducerState(): WebMessageReducerState {
  return {
    messages: [],
    toolMessageByCallId: {},
    hasVisibleFailureStatus: false,
  };
}

const MAX_WEB_TOOL_RESULT_PREVIEW_CHARS = 20_000;

function limitToolResultPreview(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_WEB_TOOL_RESULT_PREVIEW_CHARS) {
    return value;
  }
  const headLength = Math.floor(MAX_WEB_TOOL_RESULT_PREVIEW_CHARS / 2);
  const tailLength = MAX_WEB_TOOL_RESULT_PREVIEW_CHARS - headLength;
  return `${value.slice(0, headLength)}\n\n... [UI preview truncated: ${value.length - MAX_WEB_TOOL_RESULT_PREVIEW_CHARS} characters omitted] ...\n\n${value.slice(-tailLength)}`;
}

type ReducerContext = {
  sessionKey: string;
  projectKey: string | undefined;
  /** ISO timestamp shared by every message created while handling one frame. */
  stamp: string;
  newId: () => string;
};

function createReducerContext(options: WebMessageReducerOptions): ReducerContext {
  const now = options.now ?? (() => new Date());
  return {
    sessionKey: options.sessionKey,
    projectKey: options.projectKey,
    stamp: now().toISOString(),
    newId: options.newId ?? defaultNewId,
  };
}

type LiveMessageFields = Omit<WebMessage, "id" | "sessionKey" | "projectKey" | "createdAt" | "provider" | "source">;

function liveMessage(ctx: ReducerContext, fields: LiveMessageFields): WebMessage {
  return {
    id: ctx.newId(),
    sessionKey: ctx.sessionKey,
    projectKey: ctx.projectKey,
    createdAt: ctx.stamp,
    provider: "sati",
    ...fields,
    source: "live",
  };
}

type WebEventHandler<K extends WebGatewayEvent["type"]> = (
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: K }>,
  ctx: ReducerContext,
) => WebMessageReducerState;

type AnyWebEventHandler = (
  state: WebMessageReducerState,
  event: WebGatewayEvent,
  ctx: ReducerContext,
) => WebMessageReducerState;

export function applyWebGatewayEvent(
  state: WebMessageReducerState,
  event: WebGatewayEvent,
  options: WebMessageReducerOptions,
): WebMessageReducerState {
  // 表为 required Record，正常路径必有表项；undefined 分支只承接运行时传入
  // union 之外的旧帧类型，语义对齐旧 switch 的 default（原样返回）。
  const handler = WEB_EVENT_HANDLERS[event.type] as AnyWebEventHandler | undefined;
  if (handler === undefined) return state;
  return handler(state, event, createReducerContext(options));
}

/**
 * WebGatewayEvent → reducer 表（P2.9）。帧面静音种类显式列 `ignoreEvent`
 * （model_request_started / approval_* / config_changed / worktree_* /
 * context_budget / team_event 由其他投影或宿主处理）。
 */
const WEB_EVENT_HANDLERS: { [K in WebGatewayEvent["type"]]: WebEventHandler<K> } = {
  turn_started: handleTurnStarted,
  model_request_started: ignoreEvent,
  assistant_text_delta: handleAssistantTextDelta,
  assistant_thinking_delta: handleAssistantThinkingDelta,
  file_artifacts: handleFileArtifacts,
  tool_call_started: handleToolCallStarted,
  tool_call_finished: handleToolCallFinished,
  tool_result_detail_available: handleToolResultDetailAvailable,
  permission_request: handlePermissionRequest,
  approval_pending: ignoreEvent,
  approval_resolved: ignoreEvent,
  elicitation_request: handleElicitationRequest,
  elicitation_cancelled: handleElicitationCancelled,
  structured_output: handleStructuredOutput,
  plan_mode_changed: handlePlanModeChanged,
  config_changed: ignoreEvent,
  worktree_created: ignoreEvent,
  worktree_removed: ignoreEvent,
  context_budget: ignoreEvent,
  agent_status: handleAgentStatus,
  team_event: ignoreEvent,
  turn_completed: handleTurnCompleted,
  error: handleError,
};

/** 帧面静音：该帧在其他投影路径消费，不进入 WebMessage 列表。 */
function ignoreEvent(state: WebMessageReducerState): WebMessageReducerState {
  return state;
}

function handleTurnStarted(state: WebMessageReducerState): WebMessageReducerState {
  return {
    ...state,
    currentAssistantId: undefined,
    currentThinkingId: undefined,
    hasVisibleFailureStatus: false,
  };
}

function handleAssistantTextDelta(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "assistant_text_delta" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  return appendDelta(state, ctx, event.text, "text", "currentAssistantId");
}

function handleAssistantThinkingDelta(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "assistant_thinking_delta" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  return appendDelta(state, ctx, event.text, "thinking", "currentThinkingId");
}

/** 文本/思考增量：已有当前消息则追加，否则新建一条并登记为当前消息。 */
function appendDelta(
  state: WebMessageReducerState,
  ctx: ReducerContext,
  text: string,
  kind: "text" | "thinking",
  currentKey: "currentAssistantId" | "currentThinkingId",
): WebMessageReducerState {
  if (!text) {
    return state;
  }
  const currentId = state[currentKey];
  if (currentId) {
    return {
      ...state,
      messages: state.messages.map(m => (m.id === currentId ? { ...m, text: `${m.text ?? ""}${text}` } : m)),
    };
  }
  const message = liveMessage(ctx, { role: "assistant", kind, text });
  return {
    ...state,
    messages: [...state.messages, message],
    [currentKey]: message.id,
  };
}

function handleFileArtifacts(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "file_artifacts" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const message = liveMessage(ctx, { role: "assistant", kind: "file_artifacts", artifacts: event.artifacts });
  return { ...state, messages: [...state.messages, message] };
}

function handleToolCallStarted(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "tool_call_started" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const message = liveMessage(ctx, {
    role: "tool",
    kind: "tool_use",
    toolCallId: event.toolCallId,
    toolName: normalizeToolDisplayName(event.name),
    text: event.argsPreview,
  });
  return {
    ...state,
    messages: [...state.messages, message],
    toolMessageByCallId: {
      ...state.toolMessageByCallId,
      [event.toolCallId]: message.id,
    },
    currentAssistantId: undefined,
  };
}

function handleToolCallFinished(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "tool_call_finished" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const normalizedErrorCode = normalizeToolErrorCode(event.errorCode, event.resultPreview);
  const images = toLiveImages(event.images);
  const matchedId = state.toolMessageByCallId[event.toolCallId];
  if (matchedId) {
    return {
      ...state,
      messages: state.messages.map(m =>
        m.id === matchedId
          ? {
              ...m,
              kind: "tool_result",
              ok: event.ok,
              text: limitToolResultPreview(event.resultPreview) ?? m.text,
              ...(images ? { images } : {}),
              ...(normalizedErrorCode && { errorCode: normalizedErrorCode }),
              ...(event.data !== undefined ? { payload: event.data } : {}),
            }
          : m,
      ),
    };
  }
  const message = liveMessage(ctx, {
    role: "tool",
    kind: "tool_result",
    toolCallId: event.toolCallId,
    ok: event.ok,
    text: limitToolResultPreview(event.resultPreview),
    ...(images ? { images } : {}),
    ...(normalizedErrorCode && { errorCode: normalizedErrorCode }),
    ...(event.data !== undefined ? { payload: event.data } : {}),
  });
  return {
    ...state,
    messages: [...state.messages, message],
  };
}

function toLiveImages(
  images: Extract<WebGatewayEvent, { type: "tool_call_finished" }>["images"],
): WebMessage["images"] {
  if (!Array.isArray(images) || images.length === 0) {
    return undefined;
  }
  return images.map(image => ({
    data: `data:${image.mimeType};base64,${image.data}`,
    mimeType: image.mimeType,
  }));
}

function handleToolResultDetailAvailable(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "tool_result_detail_available" }>,
): WebMessageReducerState {
  const matchedId = state.toolMessageByCallId[event.toolCallId];
  if (!matchedId) {
    return state;
  }
  return {
    ...state,
    messages: state.messages.map(m =>
      m.id === matchedId
        ? {
            ...m,
            ...(event.resultPath ? { resultPath: event.resultPath } : {}),
          }
        : m,
    ),
  };
}

function handlePermissionRequest(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "permission_request" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const message = liveMessage(ctx, {
    role: "permission",
    kind: "permission_request",
    requestId: event.requestId,
    toolName: event.toolName,
    payload: event.payload,
  });
  return {
    ...state,
    messages: [...state.messages, message],
    currentAssistantId: undefined,
  };
}

function handleElicitationRequest(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "elicitation_request" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const message = liveMessage(ctx, {
    role: "system",
    kind: "elicitation_request",
    requestId: event.requestId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    payload: {
      questions: event.questions,
      previewFormat: event.previewFormat,
      metadata: event.metadata,
    },
  });
  return {
    ...state,
    messages: [...state.messages, message],
    currentAssistantId: undefined,
  };
}

function handleElicitationCancelled(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "elicitation_cancelled" }>,
): WebMessageReducerState {
  return {
    ...state,
    messages: state.messages.map(m =>
      m.kind === "elicitation_request" && m.requestId === event.requestId
        ? { ...m, kind: "status", role: "system", text: "elicitation cancelled" }
        : m,
    ),
  };
}

function handleStructuredOutput(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "structured_output" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const message = liveMessage(ctx, { role: "system", kind: "structured_output", payload: event.payload });
  return { ...state, messages: [...state.messages, message] };
}

function handlePlanModeChanged(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "plan_mode_changed" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const message = liveMessage(ctx, { role: "system", kind: "status", text: `mode → ${event.mode}` });
  return { ...state, messages: [...state.messages, message] };
}

function handleTurnCompleted(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "turn_completed" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const message = liveMessage(ctx, {
    role: "system",
    kind: "complete",
    usage: event.usage,
    finishReason: event.finishReason,
  });
  return {
    ...state,
    messages: [...state.messages, message],
    currentAssistantId: undefined,
    currentThinkingId: undefined,
  };
}

function handleAgentStatus(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "agent_status" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  const isErrorStatus = isErrorAgentStatusEvent(event);
  if (!isErrorStatus && !STATUS_AGENT_STATUS_EVENTS.has(event.event)) {
    return state;
  }
  const detail = event.detail ?? {};
  const kind = isErrorStatus ? "error" : "status";
  const message = liveMessage(ctx, {
    role: kind === "error" ? "error" : "system",
    kind,
    text: agentStatusText(detail, kind),
    ...(isI18nDescriptor(detail.messageI18n) ? { contentI18n: detail.messageI18n } : {}),
    ...(isI18nDescriptor(detail.userHintI18n) ? { userHintI18n: detail.userHintI18n } : {}),
    payload: {
      event: event.event,
      detail,
      ...(typeof detail.userHint === "string" ? { userHint: detail.userHint } : {}),
      ...(isI18nDescriptor(detail.messageI18n) ? { contentI18n: detail.messageI18n } : {}),
      ...(isI18nDescriptor(detail.userHintI18n) ? { userHintI18n: detail.userHintI18n } : {}),
    },
  });
  return {
    ...state,
    messages: [...state.messages, message],
    currentAssistantId: undefined,
    currentThinkingId: undefined,
    hasVisibleFailureStatus: state.hasVisibleFailureStatus || (kind === "error" && detail.visible !== false),
  };
}

function agentStatusText(detail: Record<string, unknown>, kind: "error" | "status"): string {
  if (typeof detail.message === "string" && detail.message.length > 0) {
    return detail.message;
  }
  return kind === "error"
    ? "The model stream ended unexpectedly, so the response may be incomplete."
    : "This turn ended before producing a standard assistant response.";
}

function handleError(
  state: WebMessageReducerState,
  event: Extract<WebGatewayEvent, { type: "error" }>,
  ctx: ReducerContext,
): WebMessageReducerState {
  if (state.hasVisibleFailureStatus) {
    return {
      ...state,
      currentAssistantId: undefined,
      currentThinkingId: undefined,
    };
  }
  const message = liveMessage(ctx, {
    role: "error",
    kind: "error",
    text: event.message,
    payload: {
      code: event.code,
      recoverable: event.recoverable,
      ...(event.userHint ? { userHint: event.userHint } : {}),
    },
  });
  return {
    ...state,
    messages: [...state.messages, message],
    currentAssistantId: undefined,
    currentThinkingId: undefined,
  };
}

function defaultNewId(): string {
  // Browsers + Node 25 both expose `crypto.randomUUID`.
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return `web-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function isI18nDescriptor(value: unknown): value is { key: string; params?: Record<string, unknown> } {
  return typeof value === "object" && value !== null && typeof (value as { key?: unknown }).key === "string";
}

function isErrorAgentStatusEvent(event: WebGatewayEvent & { type: "agent_status" }): boolean {
  return ERROR_AGENT_STATUS_EVENTS.has(event.event) || isVisibleFailureStatusDetail(event.detail);
}
