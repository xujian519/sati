/**
 * src/gateway/client — 会话遥测（telemetry）打点。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮 3）：resolveSubmitTurnTelemetry /
 * createGatewayFailureStatus / emitSessionTelemetry / inferToolErrorCategory。
 *
 * P2.1 追加：turn 级失败的两个具名构造（createTurnTimeoutFailure /
 * createSubmitFailedFailure）+ 其共用的 createTurnFailure；原
 * createGatewayFailureStatus 收为模块私有（此前唯一的消费者是 submitTurn）。
 *
 * P2.3（issue #646）：emitSessionTelemetry 的 ~330 行 switch 改为
 * AGENT_EVENT_TELEMETRY 查表 —— 与 P2.2 eventMapping 同构的 required Record，
 * AgentEvent union 新增种类时 typecheck 强制补表项，不再被 default 静默吞掉；
 * 各分支收敛到 trackLoopStage / trackSessionError / trackModelStreamTelemetry
 * 三个打点 helper（module="session" 与 context 投影的公共字段一次成型）。
 */

import type { AgentEvent } from "../../agent/index.js";
import type { CanonicalModelEvent } from "../../model/index.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import type { TelemetryClient, TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";
import type { GatewayEvent, GatewayRecordAgentStatusMessageInput, GatewaySubmitTurnInput } from "../protocol/types.js";

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

function createGatewayFailureStatus(args: {
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

/** turn 级失败的两种产物：落盘 status + 流内 error 事件（`submitTurn` 的兜底分支用）。 */
export type TurnFailure = {
  status: GatewayRecordAgentStatusMessageInput["status"];
  event: Extract<GatewayEvent, { type: "error" }>;
};

/**
 * 由同一份 message / userHint 派生「落盘 status + 流内 error 事件」。
 *
 * 两份文案必须逐字一致：拆成两处字面量写过（P2.1 前），改一边漏一边不会红。
 * `detail` 只进 status —— 它是落盘侧的诊断信息，不进面向用户的事件体。
 */
function createTurnFailure(args: {
  event: string;
  code: string;
  message: string;
  userHint: string;
  recoverable: boolean;
  runId: string;
  detail?: Record<string, unknown>;
}): TurnFailure {
  return {
    status: createGatewayFailureStatus({
      event: args.event,
      code: args.code,
      message: args.message,
      userHint: args.userHint,
      detail: args.detail,
    }),
    event: {
      type: "error",
      runId: args.runId,
      code: args.code,
      message: args.message,
      recoverable: args.recoverable,
      userHint: args.userHint,
    },
  };
}

/** 硬超时（`turn_timeout`）：消息随 timeoutMs 变化，`detail.timeoutMs` 落盘可查。 */
export function createTurnTimeoutFailure(input: { runId: string; message: string; timeoutMs: number }): TurnFailure {
  return createTurnFailure({
    event: "turn_timeout",
    code: "turn_timeout",
    message: input.message,
    userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
    recoverable: false,
    runId: input.runId,
    detail: { timeoutMs: input.timeoutMs },
  });
}

/** 主链路异常（`gateway_submit_failed`）：agent turn 结束前 gateway 自身抛出。 */
export function createSubmitFailedFailure(input: { runId: string; message: string }): TurnFailure {
  return createTurnFailure({
    event: "gateway_submit_failed",
    code: "gateway_submit_failed",
    message: input.message,
    userHint:
      "Sati failed before the agent turn could finish. Retry this message; if it repeats, check the gateway logs.",
    recoverable: false,
    runId: input.runId,
  });
}

type SessionTelemetryContext = {
  sessionId: string;
  runId: string;
  channelKey: string;
  permissionMode: string;
  ownerModule: TelemetryModule;
  executionKind: TelemetryExecutionKind;
  phase?: string;
};

/** 打点公共字段：所有 session 遥测共享 module="session" 与 context 投影。 */
function sessionTrackContext(context: SessionTelemetryContext) {
  return {
    module: "session" as const,
    ownerModule: context.ownerModule,
    executionKind: context.executionKind,
    phase: context.phase,
    sessionId: context.sessionId,
  };
}

/** trackFeatureLoopStage 的表项简写：公共字段由 sessionTrackContext 投影，调用点只写差异部分。 */
function trackLoopStage(
  telemetry: TelemetryClient,
  context: SessionTelemetryContext,
  fields: {
    loopStage: "model_request" | "model_response" | "tool_prepare" | "tool_call" | "permission_check" | "loop_end";
    outcome: "success" | "failed" | "aborted";
    errorCategory?: "tool_runtime_error";
    executionKind?: TelemetryExecutionKind;
    metadata: Record<string, unknown>;
  },
): void {
  const { executionKind, ...rest } = fields;
  telemetry.trackFeatureLoopStage({
    ...sessionTrackContext(context),
    ...rest,
    ...(executionKind ? { executionKind } : {}),
  });
}

/** trackError 的表项简写：公共字段由 sessionTrackContext 投影，调用点只写差异部分。 */
function trackSessionError(
  telemetry: TelemetryClient,
  context: SessionTelemetryContext,
  error: unknown,
  fields: {
    loopStage: "model_request" | "tool_call" | "permission_check" | "loop_end";
    errorCategory:
      | "model_request_error"
      | "tool_param_error"
      | "tool_runtime_error"
      | "tool_result_parse_error"
      | "permission_error"
      | "loop_error";
    code?: string;
    toolName?: string;
    executionKind?: TelemetryExecutionKind;
    metadata: Record<string, unknown>;
  },
): void {
  const { executionKind, ...rest } = fields;
  telemetry.trackError(error, {
    ...sessionTrackContext(context),
    ...rest,
    ...(executionKind ? { executionKind } : {}),
  });
}

/** 模型流（model_event / subagent_model_event 共用）：按流事件种类打点。 */
function trackModelStreamTelemetry(
  telemetry: TelemetryClient,
  context: SessionTelemetryContext,
  streamEvent: CanonicalModelEvent,
  options: {
    executionKind: TelemetryExecutionKind;
    extraMetadata: Record<string, unknown>;
    /** 仅 session 路径：request_started 携带 permissionMode/channelKey。 */
    permissionMeta?: boolean;
  },
): void {
  const { executionKind, extraMetadata, permissionMeta } = options;
  switch (streamEvent.type) {
    case "request_started":
      trackLoopStage(telemetry, context, {
        loopStage: "model_request",
        outcome: "success",
        executionKind,
        metadata: {
          runId: context.runId,
          provider: streamEvent.provider,
          model: streamEvent.model,
          ...(streamEvent.providerBaseUrl ? { providerBaseUrl: streamEvent.providerBaseUrl } : {}),
          ...(permissionMeta ? { permissionMode: context.permissionMode, channelKey: context.channelKey } : {}),
          ...extraMetadata,
        },
      });
      return;
    case "message_end":
      trackLoopStage(telemetry, context, {
        loopStage: "model_response",
        outcome: "success",
        executionKind,
        metadata: { runId: context.runId, ...extraMetadata },
      });
      return;
    case "error":
      trackSessionError(telemetry, context, streamEvent.error, {
        loopStage: "model_request",
        errorCategory: "model_request_error",
        code: streamEvent.error.code,
        executionKind,
        metadata: { runId: context.runId, provider: streamEvent.error.provider, ...extraMetadata },
      });
      return;
    default:
      return;
  }
}

type SessionTelemetryMapper<K extends AgentEvent["type"]> = (
  telemetry: TelemetryClient,
  event: Extract<AgentEvent, { type: K }>,
  context: SessionTelemetryContext,
) => void;

/** 遥测静音的表项（表为 required Record，签名仍需 telemetry 形参）。 */
function silentTelemetry(): void {}

/**
 * AgentEvent → telemetry 打点表（P2.3）。required Record：AgentEvent union 新增种类时
 * typecheck 强制补表项（旧 switch default 的静默返回收敛为 emitSessionTelemetry 里
 * 唯一的防御分支）。表项内只写差异字段，公共字段由 helper 投影。
 */
const AGENT_EVENT_TELEMETRY: { [K in AgentEvent["type"]]: SessionTelemetryMapper<K> } = {
  // —— 打点分支 ——
  model_event: (telemetry, event, context) =>
    trackModelStreamTelemetry(telemetry, context, event.event, {
      executionKind: context.executionKind,
      extraMetadata: {},
      permissionMeta: true,
    }),
  tool_calls_detected: (telemetry, event, context) =>
    trackLoopStage(telemetry, context, {
      loopStage: "tool_prepare",
      outcome: "success",
      metadata: {
        runId: context.runId,
        toolCount: event.calls.length,
        toolNames: event.calls.map(call => call.name),
      },
    }),
  pre_tool_execute: (telemetry, event, context) =>
    trackLoopStage(telemetry, context, {
      loopStage: "tool_call",
      outcome: "success",
      metadata: { runId: context.runId, toolName: event.toolName, toolCallId: event.toolCallId },
    }),
  post_tool_execute: (telemetry, event, context) =>
    trackLoopStage(telemetry, context, {
      loopStage: "tool_call",
      outcome: event.success ? "success" : "failed",
      ...(event.success ? {} : { errorCategory: "tool_runtime_error" as const }),
      metadata: {
        runId: context.runId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        success: event.success,
      },
    }),
  tool_result: (telemetry, event, context) => {
    if (event.result.type !== "error") return;
    const code = event.result.error.code;
    trackSessionError(telemetry, context, event.result.error.message, {
      loopStage: "tool_call",
      errorCategory: inferToolErrorCategory(code),
      code,
      toolName: event.result.toolName,
      metadata: {
        runId: context.runId,
        toolName: event.result.toolName,
        toolCallId: event.result.toolCallId,
      },
    });
  },
  permission_requested: (telemetry, event, context) =>
    trackLoopStage(telemetry, context, {
      loopStage: "permission_check",
      outcome: "success",
      metadata: { runId: context.runId, toolName: event.toolName, toolCallId: event.toolCallId },
    }),
  permission_denied: (telemetry, event, context) =>
    trackSessionError(telemetry, context, event.reason, {
      loopStage: "permission_check",
      errorCategory: "permission_error",
      code: "permission_denied",
      toolName: event.toolName,
      metadata: { runId: context.runId, toolName: event.toolName },
    }),
  turn_completed: (telemetry, event, context) =>
    trackLoopStage(telemetry, context, {
      loopStage: "loop_end",
      outcome: "success",
      metadata: { runId: context.runId, stopReason: event.result.stopReason, turns: event.result.turns },
    }),
  turn_failed: (telemetry, event, context) =>
    trackSessionError(telemetry, context, event.error, {
      loopStage: "loop_end",
      errorCategory: "loop_error",
      code: event.error.code,
      metadata: { runId: context.runId },
    }),
  session_aborted: (telemetry, event, context) =>
    trackLoopStage(telemetry, context, {
      loopStage: "loop_end",
      outcome: "aborted",
      metadata: { runId: context.runId, reason: event.reason },
    }),
  subagent_model_event: (telemetry, event, context) =>
    trackModelStreamTelemetry(telemetry, context, event.event, {
      executionKind: "subagent",
      extraMetadata: { subagentId: event.subagentId, subagentType: event.subagentType },
    }),
  subagent_tool_calls_detected: (telemetry, event, context) =>
    trackLoopStage(telemetry, context, {
      loopStage: "tool_prepare",
      outcome: "success",
      executionKind: "subagent",
      metadata: {
        runId: context.runId,
        subagentId: event.subagentId,
        subagentType: event.subagentType,
        toolCount: event.calls.length,
        toolNames: event.calls.map(call => call.name),
      },
    }),
  subagent_tool_result: (telemetry, event, context) => {
    if (event.result.type === "error") {
      trackSessionError(telemetry, context, event.result.error.message, {
        loopStage: "tool_call",
        errorCategory: inferToolErrorCategory(event.result.error.code),
        code: event.result.error.code,
        toolName: event.result.toolName,
        executionKind: "subagent",
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
    trackLoopStage(telemetry, context, {
      loopStage: "tool_call",
      outcome: "success",
      executionKind: "subagent",
      metadata: {
        runId: context.runId,
        subagentId: event.subagentId,
        subagentType: event.subagentType,
        toolName: event.result.toolName,
        toolCallId: event.result.toolCallId,
      },
    });
  },

  // —— 遥测静音：以下事件不打 session 遥测点 ——
  turn_started: silentTelemetry,
  session_started: silentTelemetry,
  session_ended: silentTelemetry,
  input_accepted: silentTelemetry,
  user_prompt_submitted: silentTelemetry,
  setup_completed: silentTelemetry,
  instructions_loaded: silentTelemetry,
  assistant_message: silentTelemetry,
  file_artifacts: silentTelemetry,
  mode_change_requested: silentTelemetry,
  steer_applied: silentTelemetry,
  steer_unapplied: silentTelemetry,
  token_cap_adjusted: silentTelemetry,
  empty_output_recovery: silentTelemetry,
  model_recovery_failed: silentTelemetry,
  compact_started: silentTelemetry,
  compact_completed: silentTelemetry,
  warning: silentTelemetry,
  agent_status: silentTelemetry,
  turn_continued: silentTelemetry,
  tool_results_projected: silentTelemetry,
  context_budget: silentTelemetry,
  subagent_started: silentTelemetry,
  subagent_completed: silentTelemetry,
  subagent_status: silentTelemetry,
  retry_progress: silentTelemetry,
  stop_requested: silentTelemetry,
  stop_failure: silentTelemetry,
  elicitation_requested: silentTelemetry,
  elicitation_resolved: silentTelemetry,
  doomloop_signal: silentTelemetry,
  // model_request_started 在旧 switch 中为显式空分支，语义等同静音组。
  model_request_started: silentTelemetry,
};

export function emitSessionTelemetry(
  telemetry: TelemetryClient | undefined,
  event: AgentEvent,
  context: SessionTelemetryContext,
): void {
  if (!telemetry) return;
  // 表为 required Record，正常路径必有表项；undefined 分支只承接运行时传入 union
  // 之外的旧事件类型，语义对齐旧 switch 的 default（静默返回）。
  const mapper = AGENT_EVENT_TELEMETRY[event.type] as
    | ((telemetry: TelemetryClient, event: AgentEvent, context: SessionTelemetryContext) => void)
    | undefined;
  if (mapper === undefined) return;
  mapper(telemetry, event, context);
}

export function inferToolErrorCategory(
  code: string | undefined,
): "tool_param_error" | "tool_runtime_error" | "tool_result_parse_error" {
  if (!code) return "tool_runtime_error";
  if (/(invalid|argument|param|schema)/i.test(code)) return "tool_param_error";
  if (/(parse|json|decode|format)/i.test(code)) return "tool_result_parse_error";
  return "tool_runtime_error";
}
