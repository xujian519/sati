/**
 * src/gateway/client — 会话遥测（telemetry）打点。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮 3）：resolveSubmitTurnTelemetry /
 * createGatewayFailureStatus / emitSessionTelemetry / inferToolErrorCategory。
 * emitSessionTelemetry 为 ~330 行 switch（AgentEvent → telemetry 客户端），
 * 是自由函数区第二大单体。
 */

import type { AgentEvent } from "../../agent/index.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import type { TelemetryClient, TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";
import type { GatewayRecordAgentStatusMessageInput, GatewaySubmitTurnInput } from "../protocol/types.js";

export function resolveSubmitTurnTelemetry(input: GatewaySubmitTurnInput): {
  ownerModule: TelemetryModule;
  executionKind: TelemetryExecutionKind;
  phase?: string;
} {
  if (input.telemetry?.ownerModule && input.telemetry.executionKind) {
    return {
      ownerModule: input.telemetry.ownerModule,
      executionKind: input.telemetry.executionKind,
      phase: input.telemetry.phase,
    };
  }
  if (String(input.channelKey).startsWith("always-on/")) {
    return {
      ownerModule: "always_on",
      executionKind: "always_on",
      phase: String(input.channelKey).slice("always-on/".length) || input.telemetry?.phase,
    };
  }
  return {
    ownerModule: input.telemetry?.ownerModule ?? "session",
    executionKind: input.telemetry?.executionKind ?? "user_session",
    phase: input.telemetry?.phase,
  };
}

export function createGatewayFailureStatus(args: {
  event: string;
  code: string;
  message: string;
  userHint: string;
  detail?: Record<string, unknown>;
}): GatewayRecordAgentStatusMessageInput["status"] {
  return {
    event: args.event,
    kind: "error",
    text: args.message,
    detail: createVisibleErrorStatusDetail({
      message: args.message,
      code: args.code,
      userHint: args.userHint,
      scope: "turn",
      source: "gateway",
      detail: args.detail,
    }),
  };
}

export function emitSessionTelemetry(
  telemetry: TelemetryClient | undefined,
  event: AgentEvent,
  context: {
    sessionId: string;
    runId: string;
    channelKey: string;
    permissionMode: string;
    ownerModule: TelemetryModule;
    executionKind: TelemetryExecutionKind;
    phase?: string;
  },
): void {
  if (!telemetry) return;
  switch (event.type) {
    case "model_request_started":
      return;
    case "model_event":
      if (event.event.type === "request_started") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "model_request",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: {
            runId: context.runId,
            provider: event.event.provider,
            model: event.event.model,
            ...(event.event.providerBaseUrl ? { providerBaseUrl: event.event.providerBaseUrl } : {}),
            permissionMode: context.permissionMode,
            channelKey: context.channelKey,
          },
        });
        return;
      }
      if (event.event.type === "message_end") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "model_response",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: { runId: context.runId },
        });
      }
      if (event.event.type === "error") {
        telemetry.trackError(event.event.error, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "model_request",
          errorCategory: "model_request_error",
          sessionId: context.sessionId,
          code: event.event.error.code,
          metadata: {
            runId: context.runId,
            provider: event.event.error.provider,
          },
        });
      }
      return;
    case "tool_calls_detected":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "tool_prepare",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolCount: event.calls.length,
          toolNames: event.calls.map(call => call.name),
        },
      });
      return;
    case "pre_tool_execute":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "tool_call",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        },
      });
      return;
    case "post_tool_execute":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "tool_call",
        outcome: event.success ? "success" : "failed",
        errorCategory: event.success ? undefined : "tool_runtime_error",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          success: event.success,
        },
      });
      return;
    case "tool_result":
      if (event.result.type === "error") {
        const code = event.result.error.code;
        telemetry.trackError(event.result.error.message, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "tool_call",
          errorCategory: inferToolErrorCategory(code),
          sessionId: context.sessionId,
          code,
          toolName: event.result.toolName,
          metadata: {
            runId: context.runId,
            toolName: event.result.toolName,
            toolCallId: event.result.toolCallId,
          },
        });
      }
      return;
    case "permission_requested":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "permission_check",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        },
      });
      return;
    case "permission_denied":
      telemetry.trackError(event.reason, {
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "permission_check",
        errorCategory: "permission_error",
        sessionId: context.sessionId,
        code: "permission_denied",
        toolName: event.toolName,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
        },
      });
      return;
    case "turn_completed":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "loop_end",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          stopReason: event.result.stopReason,
          turns: event.result.turns,
        },
      });
      return;
    case "turn_failed":
      telemetry.trackError(event.error, {
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "loop_end",
        errorCategory: "loop_error",
        sessionId: context.sessionId,
        code: event.error.code,
        metadata: {
          runId: context.runId,
        },
      });
      return;
    case "session_aborted":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "loop_end",
        outcome: "aborted",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          reason: event.reason,
        },
      });
      return;
    case "subagent_model_event":
      if (event.event.type === "request_started") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "model_request",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: {
            runId: context.runId,
            provider: event.event.provider,
            model: event.event.model,
            ...(event.event.providerBaseUrl ? { providerBaseUrl: event.event.providerBaseUrl } : {}),
            subagentId: event.subagentId,
            subagentType: event.subagentType,
          },
        });
      }
      if (event.event.type === "message_end") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "model_response",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: {
            runId: context.runId,
            subagentId: event.subagentId,
            subagentType: event.subagentType,
          },
        });
      }
      if (event.event.type === "error") {
        telemetry.trackError(event.event.error, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "model_request",
          errorCategory: "model_request_error",
          sessionId: context.sessionId,
          code: event.event.error.code,
          metadata: {
            runId: context.runId,
            provider: event.event.error.provider,
            subagentId: event.subagentId,
            subagentType: event.subagentType,
          },
        });
      }
      return;
    case "subagent_tool_calls_detected":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: "subagent",
        phase: context.phase,
        loopStage: "tool_prepare",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCount: event.calls.length,
          toolNames: event.calls.map(call => call.name),
        },
      });
      return;
    case "subagent_tool_result":
      if (event.result.type === "error") {
        telemetry.trackError(event.result.error.message, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "tool_call",
          errorCategory: inferToolErrorCategory(event.result.error.code),
          sessionId: context.sessionId,
          code: event.result.error.code,
          toolName: event.result.toolName,
          metadata: {
            runId: context.runId,
            subagentId: event.subagentId,
            subagentType: event.subagentType,
            toolName: event.result.toolName,
            toolCallId: event.result.toolCallId,
          },
        });
        return;
      }
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: "subagent",
        phase: context.phase,
        loopStage: "tool_call",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolName: event.result.toolName,
          toolCallId: event.result.toolCallId,
        },
      });
      return;
    default:
      return;
  }
}

export function inferToolErrorCategory(
  code: string | undefined,
): "tool_param_error" | "tool_runtime_error" | "tool_result_parse_error" {
  if (!code) return "tool_runtime_error";
  if (/(invalid|argument|param|schema)/i.test(code)) return "tool_param_error";
  if (/(parse|json|decode|format)/i.test(code)) return "tool_result_parse_error";
  return "tool_runtime_error";
}
