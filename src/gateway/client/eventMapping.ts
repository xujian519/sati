/**
 * src/gateway/client — AgentEvent → GatewayEvent 映射。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮 2）；P2.2（issue #646）把 mapAgentEventForTurn
 * 的 417 行 switch 改为**按事件种类查表**（AGENT_EVENT_MAPPERS）：每个 AgentEvent
 * 种类一条表项，复合分支（tool_result / tool_results_projected 等）落到具名函数。
 * 表为 AgentEvent 全种类的 required Record——新增事件种类时 typecheck 强制补表项，
 * 不再可能被 switch default 静默吞掉。
 *
 * 注意：① tool_result 分支含**落盘 IO**（tmp 持久化，best-effort），本文件非纯函数；
 * 其余分支纯映射。② 帧对象一律在**数组字面量**里构造而非经 helper 调用传参——
 * gen-event-matrix 的 producer 启发式只认「调用表达式首参对象字面量」，保持本
 * 文件的矩阵 producer 行不因重构而漂移（docs/event-producer-consumer.md）。
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

type AgentEventMapper<K extends AgentEvent["type"]> = (
  event: Extract<AgentEvent, { type: K }>,
  runId: string,
) => GatewayEvent[];

/**
 * AgentEvent → GatewayEvent 映射表（P2.2）：表项按「直通 / agent_status 投影 /
 * 复合映射 / 帧面静音」分组。required Record 保证 AgentEvent union 新增种类时
 * 编译期必须处置（旧 switch default 的静默 [] 面收敛为下 Dispatch 处唯一的防御分支）。
 * 改任何表项的帧形状前，先读文件头注释②的矩阵约束。
 */
const AGENT_EVENT_MAPPERS: { [K in AgentEvent["type"]]: AgentEventMapper<K> } = {
  // —— 直通帧 ——
  turn_started: (_event, runId) => [{ type: "turn_started", runId }],
  model_request_started: event => [{ type: "model_request_started", model: event.model, provider: event.provider }],
  file_artifacts: event => [{ type: "file_artifacts", artifacts: event.artifacts }],
  mode_change_requested: event => [{ type: "plan_mode_changed", mode: event.mode }],
  steer_applied: event => [{ type: "steer_applied", steerId: event.steerId, preview: event.preview }],
  steer_unapplied: event => [
    { type: "steer_unapplied", steerId: event.steerId, preview: event.preview, reason: event.reason },
  ],

  // —— agent_status 投影（detail 为源事件字段的子集投影） ——
  token_cap_adjusted: event => [
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
  ],
  empty_output_recovery: event => [
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
  ],
  model_recovery_failed: event => [
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
  ],
  compact_started: event => [
    {
      type: "agent_status",
      event: "compact_started",
      detail: { compactionId: event.compactionId, trigger: event.trigger, preTokens: event.preTokens },
    },
  ],
  compact_completed: event => [
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
  ],
  warning: event => [
    {
      type: "agent_status",
      event: "warning",
      detail: { code: event.code, message: event.message, metadata: event.metadata },
    },
  ],
  agent_status: event => [{ type: "agent_status", event: event.event, detail: event.detail }],
  turn_continued: event => [{ type: "agent_status", event: "turn_continued", detail: { reason: event.reason } }],
  subagent_started: event => [
    {
      type: "agent_status",
      event: "subagent_started",
      detail: { subagentId: event.subagentId, subagentType: event.subagentType, toolCallId: event.toolCallId },
    },
  ],
  subagent_completed: event => [
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
  ],
  subagent_status: event => [
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
  ],
  retry_progress: event => [
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
  ],

  // —— 复合映射（帧构造在具名函数里） ——
  model_event: (event, runId) => mapModelEvent(event.event, runId),
  tool_calls_detected: event => mapToolCallsDetected(event),
  tool_result: event => mapToolResultEvent(event),
  tool_results_projected: event => mapToolResultsProjected(event),
  turn_completed: event => mapTurnCompleted(event.result),
  turn_failed: event => mapTurnFailedEvent(event),
  session_aborted: event => mapSessionAbortedEvent(event),
  context_budget: event => mapContextBudgetEvent(event),
  subagent_model_event: event => mapSubagentModelEvent(event),
  subagent_tool_calls_detected: event => mapSubagentToolCallsDetected(event),
  subagent_tool_result: event => mapSubagentToolResultEvent(event),

  // —— 帧面静音：以下事件在 gateway 帧面不产出（UI 经由其他事件/通道获知） ——
  session_started: () => [],
  session_ended: () => [],
  input_accepted: () => [],
  user_prompt_submitted: () => [],
  setup_completed: () => [],
  instructions_loaded: () => [],
  assistant_message: () => [],
  pre_tool_execute: () => [],
  post_tool_execute: () => [],
  permission_requested: () => [],
  permission_denied: () => [],
  stop_requested: () => [],
  stop_failure: () => [],
  elicitation_requested: () => [],
  elicitation_resolved: () => [],
  doomloop_signal: () => [],
};

function mapAgentEventForTurn(event: AgentEvent, runId: string): GatewayEvent[] {
  // 表为 required Record，正常路径必有表项；undefined 分支只承接运行时传入 union
  // 之外的旧事件类型，语义对齐旧 switch 的 default（返回 []）。
  const mapper = AGENT_EVENT_MAPPERS[event.type] as ((event: AgentEvent, runId: string) => GatewayEvent[]) | undefined;
  if (mapper === undefined) return [];
  return mapper(event, runId);
}

function mapToolCallsDetected(event: Extract<AgentEvent, { type: "tool_calls_detected" }>): GatewayEvent[] {
  return event.calls.map(call => ({
    type: "tool_call_started",
    toolCallId: call.id,
    name: call.name,
    argsPreview: previewUnknown(call.input),
  }));
}

function mapToolResultEvent(event: Extract<AgentEvent, { type: "tool_result" }>): GatewayEvent[] {
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
    persistToolResultText(dir, resultPath, fullText);
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

/** 大结果 best-effort 落盘（审计用）：异步 fire-and-forget，失败静默——事件帧已同步携带 resultPath，投递不依赖落盘成功。 */
function persistToolResultText(dir: string, resultPath: string, fullText: string): void {
  void (async () => {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(resultPath, fullText, { mode: 0o600 });
    } catch {
      // 持久化失败：事件已通过其他通道投递，落盘仅审计用（best-effort）。
    }
  })();
}

function mapToolResultsProjected(event: Extract<AgentEvent, { type: "tool_results_projected" }>): GatewayEvent[] {
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

function mapTurnFailedEvent(event: Extract<AgentEvent, { type: "turn_failed" }>): GatewayEvent[] {
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
}

function mapSessionAbortedEvent(event: Extract<AgentEvent, { type: "session_aborted" }>): GatewayEvent[] {
  return [
    {
      type: "error",
      code: "agent_aborted",
      message: event.reason ?? "Session aborted.",
      recoverable: true,
    },
  ];
}

function mapContextBudgetEvent(event: Extract<AgentEvent, { type: "context_budget" }>): GatewayEvent[] {
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
      fixedOverheadTokens: event.snapshot.fixedOverheadTokens,
      total: totalContextTokens,
      effectiveTotal: event.snapshot.effectiveContextTokens ?? event.snapshot.maxContextTokens,
      reservedOutputTokens,
      ratio: event.snapshot.ratio,
      state: event.snapshot.state,
    },
  ];
}

function mapSubagentToolCallsDetected(
  event: Extract<AgentEvent, { type: "subagent_tool_calls_detected" }>,
): GatewayEvent[] {
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
}

function mapSubagentToolResultEvent(event: Extract<AgentEvent, { type: "subagent_tool_result" }>): GatewayEvent[] {
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
