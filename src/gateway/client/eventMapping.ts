/**
 * src/gateway/client — AgentEvent → GatewayEvent 映射。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮 2）：clone/runId 助手 + mapAgentEvent /
 * mapAgentEventForTurn / mapModelEvent / mapSubagentModelEvent / mapTurnCompleted。
 * 注意：mapAgentEventForTurn 的 tool_result 分支含**落盘 IO**（tmp 持久化，
 * best-effort），迁移后本文件非纯函数；其余分支纯映射。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent, AgentTurnResult } from "../../agent/index.js";
import { flattenToolResultBlockText, type CanonicalModelEvent } from "../../model/index.js";
import { contentToText } from "../../tool/index.js";
import type { GatewayEvent } from "../protocol/types.js";
import {
  extensionForMime,
  limitGatewayToolResultPreview,
  previewUnknown,
  safeGatewayPathPart,
  sanitizeGatewayToolData,
} from "./toolResultSanitize.js";
import { providerErrorFromAgentError, providerErrorFromModelError } from "./providerError.js";

export function cloneGatewayEvent(event: GatewayEvent): GatewayEvent {
  // structuredClone 优于 JSON.parse(JSON.stringify)：保留 undefined 语义、
  // 无字符串往返开销；GatewayEvent 为纯 JSON 数据（协议帧），无函数/符号。
  return structuredClone(event);
}

export function getGatewayEventRunId(event: GatewayEvent): string | undefined {
  return typeof event.runId === "string" && event.runId.trim() ? event.runId.trim() : undefined;
}

function withGatewayRunId(event: GatewayEvent, runId: string): GatewayEvent {
  if (getGatewayEventRunId(event)) return event;
  return { ...event, runId };
}

export function mapAgentEvent(event: AgentEvent, runId: string): GatewayEvent[] {
  return mapAgentEventForTurn(event, runId).map(gatewayEvent => withGatewayRunId(gatewayEvent, runId));
}

function mapAgentEventForTurn(event: AgentEvent, runId: string): GatewayEvent[] {
  switch (event.type) {
    case "turn_started":
      return [{ type: "turn_started", runId }];
    case "model_request_started":
      return [{ type: "model_request_started", model: event.model, provider: event.provider }];
    case "model_event":
      return mapModelEvent(event.event, runId);
    case "tool_calls_detected":
      return event.calls.map(call => ({
        type: "tool_call_started",
        toolCallId: call.id,
        name: call.name,
        argsPreview: previewUnknown(call.input),
      }));
    case "tool_result": {
      const fullText = event.result.content.map(contentToText).join("\n");
      const resultPreview = limitGatewayToolResultPreview(fullText);
      const lines = fullText.split("\n");
      const lineCount = lines.length;
      const totalBytes = Buffer.byteLength(fullText, "utf-8");

      const PERSIST_THRESHOLD = 4096;
      let resultPath: string | undefined;
      if (totalBytes > PERSIST_THRESHOLD) {
        const dir = resolve(
          tmpdir(),
          "sati-tool-results",
          safeGatewayPathPart(event.sessionId),
          safeGatewayPathPart(event.turnId),
        );
        resultPath = resolve(dir, `${safeGatewayPathPart(event.result.toolCallId)}.txt`);
        void (async () => {
          try {
            await mkdir(dir, { recursive: true });
            await writeFile(resultPath!, fullText, { mode: 0o600 });
          } catch {
            // 持久化失败：事件已通过其他通道投递，落盘仅审计用（best-effort）。
          }
        })();
      }

      // Surface inline image blocks (e.g. read_file on a PNG) so hosts can
      // render them next to the tool row. Without this the picture only
      // appears on session reload via the persisted canonical message — and
      // it ends up in the "user" bubble because the wire role for tool
      // results is `user`. See `projectToolResults`.
      const images = event.result.content.flatMap(item =>
        item.type === "image"
          ? [
              {
                mimeType: item.mimeType,
                data: item.data,
                ...(item.bytes !== undefined ? { bytes: item.bytes } : {}),
                ...(item.detail ? { detail: item.detail } : {}),
              },
            ]
          : [],
      );
      const attachments = event.result.content.flatMap((item): GatewayEvent[] => {
        if (item.type === "image" && event.result.toolName !== "read_file") {
          return [
            {
              type: "assistant_attachment",
              attachment: {
                type: "image",
                mimeType: item.mimeType,
                content: item.data,
                bytes: item.bytes,
                name: `${safeGatewayPathPart(event.result.toolName)}-${safeGatewayPathPart(event.result.toolCallId)}.${extensionForMime(item.mimeType)}`,
                source: "tool_result",
                metadata: { toolCallId: event.result.toolCallId, toolName: event.result.toolName },
              },
            },
          ];
        }
        if (item.type === "file") {
          return [
            {
              type: "assistant_attachment",
              attachment: {
                type: "file",
                path: item.path,
                mimeType: item.mimeType,
                name: item.path.split(/[\\/]/).pop(),
                source: "tool_result",
                metadata: {
                  toolCallId: event.result.toolCallId,
                  toolName: event.result.toolName,
                  description: item.description,
                },
              },
            },
          ];
        }
        return [];
      });

      return [
        {
          type: "tool_call_finished",
          toolCallId: event.result.toolCallId,
          ok: event.result.type === "success",
          resultPreview,
          resultLineCount: lineCount,
          resultBytes: totalBytes,
          toolName: event.result.toolName,
          resultPath,
          ...(images.length > 0 ? { images } : {}),
          ...(event.result.type === "error" && { errorCode: event.result.error.code }),
          ...(event.result.type === "success" && event.result.data
            ? { data: sanitizeGatewayToolData(event.result.data) }
            : {}),
        },
        ...attachments,
      ];
    }
    case "file_artifacts":
      return [{ type: "file_artifacts", artifacts: event.artifacts }];
    case "mode_change_requested":
      return [{ type: "plan_mode_changed", mode: event.mode }];
    case "turn_completed":
      return mapTurnCompleted(event.result);
    case "turn_failed":
      return [
        {
          type: "error",
          code: event.error.code,
          message: event.error.message,
          recoverable: false,
          userHint: event.error.userHint,
          providerError: providerErrorFromAgentError(event.error),
        },
      ];
    case "token_cap_adjusted":
      return [
        {
          type: "agent_status",
          event: "token_cap_adjusted",
          detail: {
            provider: event.provider,
            model: event.model,
            cap: event.cap,
            previous: event.previous,
            next: event.next,
            reason: event.reason,
          },
        },
      ];
    case "empty_output_recovery":
      return [
        {
          type: "agent_status",
          event: "empty_output_recovery",
          detail: {
            provider: event.provider,
            model: event.model,
            finishReason: event.finishReason,
            previousMaxOutputTokens: event.previousMaxOutputTokens,
            nextMaxOutputTokens: event.nextMaxOutputTokens,
          },
        },
      ];
    case "model_recovery_failed":
      return [
        {
          type: "agent_status",
          event: "model_recovery_failed",
          detail: {
            provider: event.provider,
            model: event.model,
            code: event.error.code,
            message: event.error.message,
            providerError: providerErrorFromModelError(event.error),
          },
        },
      ];
    case "session_aborted":
      return [
        {
          type: "error",
          code: "agent_aborted",
          message: event.reason ?? "Session aborted.",
          recoverable: true,
        },
      ];
    case "steer_applied":
      return [{ type: "steer_applied", steerId: event.steerId, preview: event.preview }];
    case "steer_unapplied":
      return [
        {
          type: "steer_unapplied",
          steerId: event.steerId,
          preview: event.preview,
          reason: event.reason,
        },
      ];
    case "tool_results_projected": {
      const events: GatewayEvent[] = [];
      for (const block of event.message.content) {
        if (block.type === "tool_result_reference") {
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            resultPath: block.path,
          });
        } else if (block.type === "media_reference" && block.toolCallId) {
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            resultPath: block.path,
          });
          if (block.reason === "media_result_too_large") continue;
          events.push({
            type: "assistant_attachment",
            attachment: {
              type: block.mediaType === "image" ? "image" : "file",
              path: block.path,
              mimeType: block.mimeType,
              bytes: block.originalBytes,
              name: block.path.split(/[\\/]/).pop(),
              source: "media_reference",
              metadata: { toolCallId: block.toolCallId, reason: block.reason },
            },
          });
        } else if (block.type === "tool_result") {
          const projFullText = flattenToolResultBlockText(block);
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            fullText: projFullText,
          });
        }
      }
      return events;
    }
    case "compact_started":
      return [
        {
          type: "agent_status",
          event: "compact_started",
          detail: {
            compactionId: event.compactionId,
            trigger: event.trigger,
            preTokens: event.preTokens,
          },
        },
      ];
    case "compact_completed":
      return [
        {
          type: "agent_status",
          event: "compact_completed",
          detail: {
            compactionId: event.compactionId,
            trigger: event.trigger,
            status: event.status,
            preTokens: event.preTokens,
            postTokens: event.postTokens,
            messagesSummarized: event.messagesSummarized,
          },
        },
      ];
    case "context_budget":
      const reservedOutputTokens = event.snapshot.reservedOutputTokens ?? event.snapshot.maxOutputTokens ?? 0;
      const totalContextTokens =
        event.snapshot.totalContextTokens ??
        (event.snapshot.effectiveContextTokens ?? event.snapshot.maxContextTokens) + reservedOutputTokens;
      return [
        {
          type: "context_budget",
          used: event.snapshot.tokens,
          displayUsed: event.snapshot.displayTokens,
          budgetUsed: event.snapshot.budgetTokens,
          total: totalContextTokens,
          effectiveTotal: event.snapshot.effectiveContextTokens ?? event.snapshot.maxContextTokens,
          reservedOutputTokens,
          ratio: event.snapshot.ratio,
          state: event.snapshot.state,
        },
      ];
    case "warning":
      return [
        {
          type: "agent_status",
          event: "warning",
          detail: { code: event.code, message: event.message, metadata: event.metadata },
        },
      ];
    case "agent_status":
      return [
        {
          type: "agent_status",
          event: event.event,
          detail: event.detail,
        },
      ];
    case "turn_continued":
      return [
        {
          type: "agent_status",
          event: "turn_continued",
          detail: { reason: event.reason },
        },
      ];
    case "subagent_started":
      return [
        {
          type: "agent_status",
          event: "subagent_started",
          detail: { subagentId: event.subagentId, subagentType: event.subagentType, toolCallId: event.toolCallId },
        },
      ];
    case "subagent_completed":
      return [
        {
          type: "agent_status",
          event: "subagent_completed",
          detail: {
            subagentId: event.subagentId,
            subagentType: event.subagentType,
            success: event.success,
            durationMs: event.durationMs,
          },
        },
      ];
    case "subagent_model_event":
      return mapSubagentModelEvent(event);
    case "subagent_tool_calls_detected":
      return event.calls.map(call => ({
        type: "agent_status",
        event: "subagent_tool_call_started",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        },
      }));
    case "subagent_tool_result": {
      const fullText = event.result.content.map(contentToText).join("\n");
      const resultPreview = limitGatewayToolResultPreview(fullText);
      const lines = fullText.split("\n");
      return [
        {
          type: "agent_status",
          event: "subagent_tool_result",
          detail: {
            subagentId: event.subagentId,
            subagentType: event.subagentType,
            toolCallId: event.result.toolCallId,
            toolName: event.result.toolName,
            ok: event.result.type === "success",
            content: resultPreview,
            preview: limitGatewayToolResultPreview(lines.slice(0, 3).join("\n")),
            resultLineCount: lines.length,
            resultBytes: Buffer.byteLength(fullText, "utf-8"),
            ...(event.result.type === "error" && { errorCode: event.result.error.code }),
          },
        },
      ];
    }
    case "subagent_status":
      return [
        {
          type: "agent_status",
          event: "subagent_status",
          detail: {
            subagentId: event.subagentId,
            subagentType: event.subagentType,
            status: event.status,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            success: event.success,
            durationMs: event.durationMs,
          },
        },
      ];
    case "retry_progress":
      return [
        {
          type: "agent_status",
          event: "retry_progress",
          detail: {
            attempt: event.detail.attempt,
            maxAttempts: event.detail.maxAttempts,
            delayMs: event.detail.delayMs,
            reason: event.detail.reason,
            provider: event.detail.provider,
            model: event.detail.model,
          },
        },
      ];
    case "session_ended":
    case "user_prompt_submitted":
    case "setup_completed":
    case "instructions_loaded":
    case "stop_requested":
    case "stop_failure":
    case "elicitation_resolved":
      return [];
    case "pre_tool_execute":
      return [];
    case "post_tool_execute":
      return [];
    case "permission_requested":
      return [];
    case "permission_denied":
      return [];
    case "elicitation_requested":
      return [];
    default:
      return [];
  }
}

function mapModelEvent(event: CanonicalModelEvent, runId: string): GatewayEvent[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "assistant_text_delta", text: event.text, runId }];
    case "thinking_delta":
      return [{ type: "assistant_thinking_delta", text: event.text, runId }];
    case "error":
      // Model-level errors are internal control flow until AgentLoop decides
      // whether they are recoverable. Surfacing them here duplicates the final
      // turn_failed frame and also shows self-correction retries as red errors.
      return [];
    default:
      return [];
  }
}

function mapSubagentModelEvent(event: Extract<AgentEvent, { type: "subagent_model_event" }>): GatewayEvent[] {
  const base = {
    subagentId: event.subagentId,
    subagentType: event.subagentType,
  };
  switch (event.event.type) {
    case "text_delta":
      return [
        {
          type: "agent_status",
          event: "subagent_text_delta",
          detail: { ...base, text: event.event.text },
        },
      ];
    case "thinking_delta":
      return [
        {
          type: "agent_status",
          event: "subagent_thinking_delta",
          detail: { ...base, text: event.event.text },
        },
      ];
    case "error":
      return [
        {
          type: "agent_status",
          event: "subagent_model_error",
          detail: {
            ...base,
            code: event.event.error.code,
            message: event.event.error.message,
          },
        },
      ];
    default:
      return [];
  }
}

function mapTurnCompleted(result: AgentTurnResult): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  if (result.structuredOutput !== undefined) {
    events.push({ type: "structured_output", payload: result.structuredOutput });
  }
  events.push({ type: "turn_completed", usage: result.usage, finishReason: result.stopReason });
  return events;
}
