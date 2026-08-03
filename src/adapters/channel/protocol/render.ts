/**
 * Shared IM channel event renderers.
 *
 * Most IM channels render gateway events to plain text the same way. This
 * module centralizes that logic so a new channel only needs a thin wrapper
 * (or a direct call) instead of another copy of the switch.
 */

import type { GatewayEvent } from "../../../gateway/index.js";
import { isVisibleFailureStatusDetail, visibleStatusMessage } from "../../../status/agentStatus.js";

// ---------------------------------------------------------------------------
// Plain-text renderer (used by the majority of IM channels)
// ---------------------------------------------------------------------------

export type PlainTextRenderOptions = {
  /** Label used when a tool call fails. Default: "failed". */
  toolFailureLabel?: string;
  /** Tool names whose failures should be suppressed (e.g. "send_attachment"). */
  skipToolNames?: ReadonlySet<string>;
  /** Include the tool result preview in failure messages. Default: false. */
  includeResultPreview?: boolean;
};

/**
 * Render a gateway event as plain text for IM channels.
 *
 * Default behavior (used by most channels):
 * - assistant text is passed through, thinking deltas are dropped,
 * - tool failures render as `⚠️ <name> failed`, elicitation questions as a
 *   numbered list, errors as `❌ <message>`.
 */
export function renderPlainTextEvent(event: GatewayEvent, options: PlainTextRenderOptions = {}): string | undefined {
  switch (event.type) {
    case "assistant_text_delta":
      return event.text;
    case "assistant_thinking_delta":
      return "";
    case "tool_call_started":
      return "";
    case "tool_call_finished":
      if (!event.ok) {
        const name = event.toolName ?? event.toolCallId;
        if (options.skipToolNames?.has(name)) return "";
        const detail =
          options.includeResultPreview && typeof event.resultPreview === "string" && event.resultPreview.trim()
            ? `${event.resultPreview.trim()}\n`
            : "";
        return `\n⚠️ ${name} ${options.toolFailureLabel ?? "failed"}\n${detail}`;
      }
      return "";
    case "elicitation_request":
      return renderElicitationQuestions(event);
    case "error":
      return `\n❌ ${event.message}\n`;
    default:
      return undefined;
  }
}

/** Render an elicitation_request event as a numbered question list. */
export function renderElicitationQuestions(event: GatewayEvent & { type: "elicitation_request" }): string {
  const lines: string[] = [];
  for (const q of event.questions) {
    if (q.header) lines.push(`**${q.header}**`);
    if (q.question) lines.push(q.question);
    for (let i = 0; i < q.options.length; i++) {
      lines.push(`${i + 1}. ${q.options[i].label}`);
    }
  }
  return lines.length > 0 ? `\n${lines.join("\n")}\n` : "";
}

// ---------------------------------------------------------------------------
// Cli-style renderer (api-server / webhook channels)
// ---------------------------------------------------------------------------

export type CliStyleRenderOptions = {
  /** Prefix for agent_status failure messages. Default: "\nError:". */
  statusErrorPrefix?: string;
};

/** Agent status events that indicate a visible failure to the end user. */
export const VISIBLE_FAILURE_STATUS_EVENTS: ReadonlySet<string> = new Set([
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
  "channel_submit_failed",
  "subagent_failed",
  "content_filter_stop",
  "unknown_finish_reason",
]);

/** True when an agent_status event should be surfaced as a failure message. */
export function isVisibleFailureAgentStatus(event: GatewayEvent): boolean {
  if (event.type !== "agent_status") return false;
  return (
    event.detail?.visible !== false &&
    (VISIBLE_FAILURE_STATUS_EVENTS.has(event.event) || isVisibleFailureStatusDetail(event.detail))
  );
}

/**
 * Render a gateway event in the compact "cli-style" format used by the
 * api-server and webhook channels: tool progress on their own lines, and
 * agent status failures surfaced as errors.
 */
export function renderCliStyleEvent(event: GatewayEvent, options: CliStyleRenderOptions = {}): string | undefined {
  const statusPrefix = options.statusErrorPrefix ?? "\nError:";
  switch (event.type) {
    case "assistant_text_delta":
      return event.text;
    case "assistant_thinking_delta":
      return "";
    case "tool_call_started":
      return `\n[${event.name} running]\n`;
    case "tool_call_finished":
      return `\n[${event.toolName ?? event.toolCallId} ${event.ok ? "done" : "failed"}]\n`;
    case "agent_status":
      if (isVisibleFailureAgentStatus(event)) {
        return `${statusPrefix} ${visibleStatusMessage(event.detail, "Agent execution stopped before producing a complete response.")}\n`;
      }
      return undefined;
    case "error":
      return `\nError: ${event.message}\n`;
    default:
      return undefined;
  }
}
