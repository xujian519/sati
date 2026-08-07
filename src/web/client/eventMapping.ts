/**
 * Shared GatewayEvent → chat-frame mapping (browser-safe, stateless).
 *
 * Single source of truth for translating a gateway event into the legacy
 * "NormalizedMessage"-shaped wire frames consumed by the chat UI. Both the
 * Node-side bridges (`ui/server/sati-bridge.js`, `ui/server/pilotdeck-bridge.js`)
 * build on this module, so the hosts can no longer drift apart.
 *
 * Scope / ownership:
 *   - Included: pure event→frame mapping (all event types), tool-name
 *     aliasing, error-code normalization, preview truncation, the
 *     visible-failure status set.
 *   - Not included (host layer): the `id`/`timestamp` message envelope,
 *     subagent activity frames (which track per-session state), and the
 *     pending agent tool-call bookkeeping.
 */

import type { WebGatewayEvent } from "./protocol.js";

/** A chat wire frame — structurally identical to the bridge's NormalizedMessage minus id/timestamp. */
export type GatewayEventFrame = {
  kind: string;
  sessionId: string;
  provider?: string;
  runId?: string;
  [key: string]: unknown;
};

const TOOL_DISPLAY_NAME_ALIASES: Record<string, string> = {
  agent: "Task",
  ask_user_question: "AskUserQuestion",
  bash: "Bash",
  edit_file: "Edit",
  glob: "Glob",
  grep: "Grep",
  read_file: "Read",
  write_file: "Write",
};

export function normalizeToolDisplayName(name?: string): string {
  const key = name ?? "";
  if (TOOL_DISPLAY_NAME_ALIASES[key]) return TOOL_DISPLAY_NAME_ALIASES[key];
  if (key === "todo_write") return "TodoWrite";
  if (key === "todo_read") return "TodoRead";
  return key;
}

export function isSearchToolName(name?: string): boolean {
  const normalized = String(name || "").toLowerCase();
  return normalized === "grep" || normalized === "glob";
}

export function readOnlyModeToolDenyCode(text?: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  if (/\[PLAN_MODE_VIOLATION\]/i.test(text) || /plan mode denies side-effecting tool\b/i.test(text)) {
    return "plan_mode_denied";
  }
  if (/\[ASK_MODE_VIOLATION\]/i.test(text) || /ask mode denies side-effecting tool\b/i.test(text)) {
    return "ask_mode_denied";
  }
  return undefined;
}

export function normalizeToolErrorCode(errorCode?: string, resultPreview?: unknown): string | undefined {
  if (errorCode === "plan_mode_violation") return "plan_mode_denied";
  if (errorCode === "ask_mode_violation") return "ask_mode_denied";
  return readOnlyModeToolDenyCode(resultPreview) || errorCode;
}

const MAX_TOOL_RESULT_PREVIEW_CHARS = 20_000;

export function limitToolResultPreview(value?: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (text.length <= MAX_TOOL_RESULT_PREVIEW_CHARS) return text;
  const headLength = Math.floor(MAX_TOOL_RESULT_PREVIEW_CHARS / 2);
  const tailLength = MAX_TOOL_RESULT_PREVIEW_CHARS - headLength;
  return `${text.slice(0, headLength)}\n\n... [UI preview truncated: ${text.length - MAX_TOOL_RESULT_PREVIEW_CHARS} characters omitted] ...\n\n${text.slice(-tailLength)}`;
}

export function tryParseJson(value?: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Agent-status events that always surface as visible failure frames,
 * regardless of `detail.visible`. Mirrors the authoritative set in
 * `ui/server/sati-bridge.js` — the shared core is its single home.
 */
export const VISIBLE_FAILURE_AGENT_STATUS_EVENTS: ReadonlySet<string> = new Set([
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

/**
 * True when a status `detail` marks an error the UI should surface.
 * Semantics match `src/status/agentStatus.ts` (`visible !== false` AND
 * `severity === "error"`).
 */
export function isVisibleFailureStatusDetail(detail: unknown): boolean {
  if (typeof detail !== "object" || detail === null) return false;
  const record = detail as Record<string, unknown>;
  return record.visible !== false && record.severity === "error";
}

export function isVisibleFailureAgentStatus(event: Extract<WebGatewayEvent, { type: "agent_status" }>): boolean {
  return VISIBLE_FAILURE_AGENT_STATUS_EVENTS.has(event.event) || isVisibleFailureStatusDetail(event.detail);
}

/**
 * Map a gateway event to 0..n chat wire frames.
 *
 * Returns an empty array for events that are not user-visible. Hosts may
 * pre-process events (e.g. subagent frames) before calling this and must
 * add their own id/timestamp envelope if needed.
 */
export function mapGatewayEventToFrames(
  event: WebGatewayEvent,
  sessionId: string,
  provider = "sati",
): GatewayEventFrame[] {
  const base: { sessionId: string; provider: string; runId?: string } = {
    sessionId,
    provider,
    ...(event.runId ? { runId: event.runId } : {}),
  };

  switch (event.type) {
    case "turn_started":
      return [{ ...base, kind: "status", text: "started" }];

    case "model_request_started":
      return [
        {
          ...base,
          kind: "status",
          text: "model_request_started",
          model: event.model,
          provider: event.provider,
        },
      ];

    case "assistant_text_delta":
      return [{ ...base, kind: "stream_delta", content: event.text }];

    case "assistant_thinking_delta":
      return [{ ...base, kind: "thinking", content: event.text }];

    case "file_artifacts":
      return [{ ...base, kind: "file_artifacts", artifacts: Array.isArray(event.artifacts) ? event.artifacts : [] }];

    case "tool_call_started":
      return [
        {
          ...base,
          kind: "tool_use",
          toolId: event.toolCallId,
          toolName: normalizeToolDisplayName(event.name),
          toolInput: tryParseJson(event.argsPreview),
        },
      ];

    case "tool_call_finished": {
      const normalizedErrorCode = normalizeToolErrorCode(event.errorCode, event.resultPreview);
      return [
        {
          ...base,
          kind: "tool_result",
          toolId: event.toolCallId,
          content: limitToolResultPreview(event.resultPreview),
          isError: !event.ok,
          // errorCode lets the UI distinguish permission denials
          // (`permission_denied` / `permission_required`) from ordinary
          // execution failures so the "Add to Allowed Tools" affordance
          // only fires for the former.
          ...(normalizedErrorCode ? { errorCode: normalizedErrorCode } : {}),
          // Inline tool-result images (e.g. read_file on a PNG) arrive as
          // raw base64; wrap as data URLs for direct <img src> use.
          ...(Array.isArray(event.images) && event.images.length > 0
            ? {
                toolResultImages: event.images.map(image => ({
                  data: `data:${image.mimeType};base64,${image.data}`,
                  mimeType: image.mimeType,
                })),
              }
            : {}),
          ...(event.toolName === "exit_plan_mode" && event.data?.planFilePath
            ? {
                planFilePath: event.data.planFilePath,
                planTitle: event.data.planTitle,
                planSummary: event.data.planSummary,
              }
            : {}),
          ...(event.toolName === "ask_user_question" && event.data ? { toolUseResult: event.data } : {}),
          ...(isSearchToolName(event.toolName) && event.data ? { toolUseResult: event.data } : {}),
        },
      ];
    }

    case "tool_result_detail_available":
      return [
        {
          ...base,
          kind: "tool_result",
          toolId: event.toolCallId,
          content: event.resultPath
            ? `Full tool result persisted at ${event.resultPath}`
            : "Full tool result is available.",
          isError: false,
          ...(event.resultPath ? { resultPath: event.resultPath } : {}),
        },
      ];

    case "permission_request":
      return [
        {
          ...base,
          kind: "permission_request",
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.payload,
          context: { provider },
        },
      ];

    case "elicitation_request": {
      // Structured elicitation flows through the same `permission_request`
      // shape the permission banner already renders, so the registered
      // AskUserQuestion PermissionPanel renders inline in the chat.
      const isExitPlanMode = event.toolName === "exit_plan_mode";
      return [
        {
          ...base,
          kind: "permission_request",
          requestId: event.requestId,
          toolCallId: event.toolCallId,
          toolName: isExitPlanMode ? "ExitPlanModeV2" : "AskUserQuestion",
          input: isExitPlanMode
            ? {
                plan: event.metadata?.plan,
                planFilePath: event.metadata?.planFilePath,
                questions: event.questions,
                metadata: event.metadata,
              }
            : {
                questions: event.questions,
                metadata: event.metadata,
              },
          context: { provider, originalToolName: event.toolName },
          isElicitation: true,
        },
      ];
    }

    case "elicitation_cancelled":
      return [{ ...base, kind: "permission_cancelled", requestId: event.requestId }];

    case "structured_output":
      return [{ ...base, kind: "status", text: "structured", payload: event.payload }];

    case "plan_mode_changed":
      return [{ ...base, kind: "status", text: `mode:${event.mode}` }];

    case "turn_completed":
      return [
        {
          ...base,
          kind: "complete",
          exitCode: 0,
          success: true,
          finishReason: event.finishReason,
          usage: event.usage,
        },
      ];

    case "context_budget":
      return [
        {
          ...base,
          kind: "status",
          text: "token_budget",
          tokenBudget: {
            used: event.used,
            displayUsed: event.displayUsed,
            budgetUsed: event.budgetUsed,
            total: event.total,
            effectiveTotal: event.effectiveTotal,
            reservedOutputTokens: event.reservedOutputTokens,
            ratio: event.ratio,
            state: event.state,
          },
        },
      ];

    case "error":
      return [
        {
          ...base,
          kind: "error",
          content: event.message,
          code: event.code,
          recoverable: event.recoverable,
          userHint: event.userHint,
        },
      ];

    case "agent_status":
      return agentStatusToFrames(event, base);

    default:
      return [];
  }
}

function agentStatusToFrames(
  event: Extract<WebGatewayEvent, { type: "agent_status" }>,
  base: { sessionId: string; provider: string; runId?: string },
): GatewayEventFrame[] {
  const detail = (event.detail ?? {}) as Record<string, unknown>;

  if (event.event === "compact_started") {
    return [
      {
        ...base,
        kind: "status",
        text: "compacting",
        tokens: 0,
        canInterrupt: true,
        compactProgress: {
          level: detail.level || 1,
          stage: detail.stage || "compacting",
          label: detail.label || detail.stage || "Compacting",
          state: "running",
          pre_tokens: detail.preTokens,
          reason: detail.trigger,
          compaction_id: detail.compactionId,
        },
      },
    ];
  }

  if (event.event === "compact_completed") {
    return [
      {
        ...base,
        kind: "compact_boundary",
        compactionId: detail.compactionId,
        trigger: detail.trigger || "auto",
        preTokens: detail.preTokens,
        postTokens: detail.postTokens,
        messagesSummarized: detail.messagesSummarized,
        compactLevel: detail.level,
        compactStage: detail.stage,
        compactStageLabel: detail.stageLabel || detail.stage,
        compactMetadata: detail,
        ...(detail.tokenBudget ? { tokenBudget: detail.tokenBudget } : {}),
      },
    ];
  }

  if (event.event === "retry_progress") {
    const retryText =
      detail.reason === "continuation"
        ? "Continuing response"
        : detail.reason === "rate_limit" || detail.reason === "overloaded"
          ? "Switching model"
          : "Reconnecting";
    return [
      {
        ...base,
        kind: "status",
        text: `${retryText}... ${detail.attempt}/${detail.maxAttempts}`,
        tokens: 0,
        canInterrupt: true,
        retryProgress: {
          attempt: detail.attempt,
          maxAttempts: detail.maxAttempts,
          delayMs: detail.delayMs,
          reason: detail.reason,
          provider: detail.provider,
          model: detail.model,
        },
      },
    ];
  }

  if (event.event === "model_empty_response_exhausted") {
    return [
      {
        ...base,
        kind: "error",
        content:
          detail.message ||
          "The model returned empty content repeatedly, so this turn has stopped. Try again later or increase max output tokens.",
        contentI18n: detail.messageI18n,
        code: event.event,
        recoverable: false,
        userHint: detail.userHint,
        userHintI18n: detail.userHintI18n,
      },
    ];
  }

  if (event.event === "max_turns_reached") {
    return [
      {
        ...base,
        kind: "error",
        content:
          detail.message ||
          "Reached the maximum number of turns, so this turn has stopped. Increase maxTurns or split the task into smaller steps and try again.",
        contentI18n: detail.messageI18n,
        code: event.event,
        recoverable: false,
        userHint: detail.userHint,
        userHintI18n: detail.userHintI18n,
      },
    ];
  }

  if (isVisibleFailureAgentStatus(event)) {
    return [
      {
        ...base,
        kind: "error",
        content:
          detail.message ||
          "Agent execution stopped before producing a complete response. Please retry or adjust the task.",
        contentI18n: detail.messageI18n,
        code: event.event,
        recoverable: false,
        userHint: detail.userHint,
        userHintI18n: detail.userHintI18n,
      },
    ];
  }

  if (event.event === "structured_output_completed" || event.event === "turn_aborted") {
    return [
      {
        ...base,
        kind: "status",
        content: detail.message || "This turn ended before producing a standard assistant response.",
        contentI18n: detail.messageI18n,
        code: event.event,
        recoverable: false,
        userHint: detail.userHint,
        userHintI18n: detail.userHintI18n,
      },
    ];
  }

  // Remaining agent_status events (progress, subagent detail) are not
  // user-visible on this path — the host layer may pre-process them
  // (e.g. subagent activity frames) before delegating here.
  return [];
}
