/**
 * 一次模型响应的装配与异常处置：从 assembler 产物得到可用的 assistantMessage/
 * toolCalls（文本回退工具名修复、usage 归并、finalMessage 与 transient 过期、
 * doomLoop 记录），再按顺序处置三条互斥的异常响应状态机（半截文本工具调用 /
 * 修补后截断 / 空响应），最后正常落库。抽取自 AgentLoop（issue #147 / TD-AGENT-103）。
 *
 * **顺序即语义**：装配必须先于处置（处置读 finalMessage 与 toolCalls）；半截文本
 * 与修补截断两条必须先于空响应判定（前者可能已消费恢复预算，判定条件也依赖它们
 * 已把消息标脏）。重排会改变恢复行为。
 */

import {
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  textFromMessage,
  type AssembledAssistantMessage,
  type CanonicalMessage,
  type CanonicalModelRequest,
  type CanonicalToolCall,
  type CanonicalToolCallBlock,
} from "../../model/index.js";
import { repairToolName } from "../../model/streaming/repairToolName.js";
import { createLogger } from "../../telemetry/index.js";
import type { RouterDecision } from "../../router/index.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { AgentTurnResult } from "../protocol/result.js";
import { collectToolCalls } from "./collectToolCalls.js";
import { recordModelCall } from "./doomLoopIntegration.js";
import type { LargeFileRepairDecision } from "./LargeFileRepair.js";
import { mergeUsage } from "./misc.js";
import { buildPartialTextToolCallRecoveryPrompt } from "./messages.js";
import {
  createEmptyResponseStatus,
  createToolCallRecoveryExhaustedStatus,
  type AgentStatusMessage,
} from "./modelErrors.js";
import {
  continueWithTransientPrompt,
  recoverFromEmptyResponse,
  recoverFromMaxOutputBump,
} from "./recoveryStrategies.js";
import {
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  unhandled,
  type StageOutcome,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "./turnExit.js";
import { MAX_OUTPUT_RECOVERY_LIMIT, type TurnRuntimeState } from "./turnRuntimeState.js";

const agentLogger = createLogger("agent");

/** LargeFileRepair 续跑结论：继续下一轮，或直接以某个 turn 结果收尾。 */
export type SyntheticPromptOutcome =
  | { type: "continue"; event: AgentEvent }
  | { type: "completed"; result: AgentTurnResult; status?: AgentStatusMessage };

/**
 * 合成提示续跑（含 LargeFileRepair 的 `config.maxOutputTokens` 抬升，因此
 * 实现留在 AgentLoop）：本模块只按此窄接口调用。
 */
export type SyntheticPromptContinuer = (
  state: TurnRuntimeState,
  input: AgentLoopInput,
  decision: LargeFileRepairDecision,
  options?: { stripCurrentAssistant?: boolean },
) => Promise<SyntheticPromptOutcome>;

/**
 * 装配链依赖袋：turnExit 三项承接自 TurnExitDeps，其余为 AgentLoop 侧的
 * 记录器、工具名来源与续跑入口。
 */
export interface ResponseAssemblyDeps extends TurnExitDeps {
  readonly doomLoop: AgentRuntimeDependencies["doomLoop"];
  readonly eventEmitter: AgentRuntimeDependencies["eventEmitter"];
  /** 已知工具名（文本回退工具名修复的合法名集合）。 */
  readonly listToolNames: () => string[];
  readonly toolAliases: AgentRuntimeConfig["toolAliases"];
  readonly continueWithSyntheticPrompt: SyntheticPromptContinuer;
}

/** 装配产物：可用的 assistant 消息与工具调用（文本回退工具名已修复）。 */
export type AssembledResponse = {
  assembled: AssembledAssistantMessage;
  assistantMessage: CanonicalMessage;
  toolCalls: CanonicalToolCall[];
};

/** 装配结论：proceed 表示响应可用、交回主循环执行工具或收尾。 */
export type ResponseAssemblyOutcome = TurnStepContinue | TurnStepReturn | ({ kind: "proceed" } & AssembledResponse);

/**
 * 文本回退工具名修复：模型把工具调用写成正文时，解析出的名字可能带别名或
 * 大小写偏差，按注册表合法名 + `toolAliases` 纠正消息与工具调用两侧。
 */
export function repairTextExtractedToolNames(
  deps: ResponseAssemblyDeps,
  message: CanonicalMessage,
  toolCalls: CanonicalToolCall[],
): { message: CanonicalMessage; toolCalls: CanonicalToolCall[] } {
  if (toolCalls.length === 0) return { message, toolCalls };
  const validNames = new Set(deps.listToolNames());
  const repairedById = new Map<string, string>();
  const repairedToolCalls = toolCalls.map(call => {
    const repaired = repairToolName(call.name, validNames, deps.toolAliases);
    if (!repaired) return call;
    repairedById.set(call.id, repaired.name);
    return { ...call, name: repaired.name };
  });
  if (repairedById.size === 0) return { message, toolCalls };

  return {
    message: {
      ...message,
      content: message.content.map(block => {
        if (block.type !== "tool_call") return block;
        const repairedName = repairedById.get(block.id);
        return repairedName ? ({ ...block, name: repairedName } satisfies CanonicalToolCallBlock) : block;
      }),
    },
    toolCalls: repairedToolCalls,
  };
}

/**
 * 半截文本工具调用：先按最大输出恢复预算续跑（提示模型重发完整调用），
 * 预算耗尽则终止本轮——半截调用绝不执行，也绝不落库为最终消息。
 */
export async function* handlePartialTextToolCall(
  deps: ResponseAssemblyDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  response: AssembledResponse,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  if (!response.assembled.hasPartialTextToolCall) return unhandled();

  if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
    state.maxOutputRecoveryCount++;
    // 当前 assistant 消息含不安全的工具片段：恢复响应到达前若被取消，
    // 绝不能把它作为最终消息返回/落库。
    state.finalMessage = undefined;
    return yield* continueWithTransientPrompt(
      state,
      input,
      buildPartialTextToolCallRecoveryPrompt(response.assembled.partialTextToolCall),
      "max_output_recovery",
    );
  }

  const detail = response.assembled.partialTextToolCall
    ? `${response.assembled.partialTextToolCall.format}/${response.assembled.partialTextToolCall.reason}`
    : "unknown partial text tool-call";
  // 半截文本工具调用无安全最终文本（safeFinalTextMessage 恒 undefined）。
  state.finalMessage = undefined;
  const result = createTurnResult(input, {
    type: "error",
    stopReason: "model_error",
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    turns: state.turnCount,
    startedAt: state.startedAt,
    finalMessage: state.finalMessage,
    structuredOutput: state.structuredOutput,
    errors: [
      agentError(
        "agent_model_error",
        `Partial text tool-call recovery exhausted after ${MAX_OUTPUT_RECOVERY_LIMIT} attempts (${detail}).`,
      ),
    ],
  });
  yield await emitStatus(
    input,
    createToolCallRecoveryExhaustedStatus({
      error: result.errors![0]!,
      attempts: state.maxOutputRecoveryCount,
      reason: detail,
    }),
  );
  return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
}

/**
 * 修补后截断的工具调用。jsonrepair 会悄悄"修好"被 max_tokens 截断的 JSON，
 * 但参数（例如写了一半的文件内容）往往语义不完整，因此走与 max_output_reached
 * 相同的恢复：LargeFileRepair 续跑 → Phase A/B 加倍续写 → Phase C 放弃。
 *
 * 本门刻意先于 assistant 落库：恢复响应应当替换掉脏的修补消息，而不是在
 * transcript 里留下一个没有结果的 tool_call。
 */
export async function* handleRepairedTruncation(
  deps: ResponseAssemblyDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  decision: RouterDecision,
  routedMaxOutputTokens: number | undefined,
  response: AssembledResponse,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  const finishReason = response.assembled.finishReason;
  if (
    !response.assembled.hasRepairedToolCalls ||
    (finishReason !== "length" && finishReason !== "tool_call" && finishReason !== "stop")
  ) {
    return unhandled();
  }

  agentLogger.warn(
    `Blocking ${response.toolCalls.length} repaired-but-truncated tool call(s) — entering max_output recovery`,
  );

  const largeFileDecision = state.largeFileRepair.recoverFromRepairedTruncation(response.toolCalls);
  if (largeFileDecision) {
    const continued = await deps.continueWithSyntheticPrompt(state, input, largeFileDecision, {
      stripCurrentAssistant: false,
    });
    if (continued.type === "completed") {
      if (continued.status) {
        yield await emitStatus(input, continued.status);
      }
      return yield* terminateTurn(deps, input, state, continued.result, { emitFailureEvent: true });
    }
    yield continued.event;
    return { kind: "continue" };
  }

  // Phase A/B 由共享策略处理；Phase C 兜底在本步骤内。
  const recovery = yield* recoverFromMaxOutputBump(deps, state, input, decision, routedMaxOutputTokens);
  if (recovery !== "exhausted") {
    return { kind: "continue" };
  }

  // Phase C: exhausted. Do not execute repaired/truncated calls; the
  // arguments may be syntactically repaired while semantically partial.
  const result = createTurnResult(input, {
    type: "error",
    stopReason: "model_error",
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    turns: state.turnCount,
    startedAt: state.startedAt,
    finalMessage: state.finalMessage,
    structuredOutput: state.structuredOutput,
    errors: [
      agentError(
        "agent_model_error",
        "Recovered tool call still looked repaired/truncated after max-output recovery was exhausted.",
      ),
    ],
  });
  yield await emitStatus(
    input,
    createToolCallRecoveryExhaustedStatus({
      error: result.errors![0]!,
      attempts: state.maxOutputRecoveryCount,
      reason: "repaired_truncated_tool_calls",
    }),
  );
  return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
}

/**
 * 空响应（无文本、无工具调用）：通常是扩展思考吃光输出预算。先走共享的
 * 空响应恢复链（bump + 提示 / 连空终止），全部不接管时收尾为一次"成功但无
 * 内容"的 turn，并给 UI 一条状态说明——不往 transcript 注入诊断文本。
 */
export async function* handleEmptyResponse(
  deps: ResponseAssemblyDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  request: CanonicalModelRequest,
  decision: RouterDecision,
  routedMaxOutputTokens: number | undefined,
  response: AssembledResponse,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  if (response.toolCalls.length > 0 || textFromMessage(response.assistantMessage).length > 0) return unhandled();

  const recovery = yield* recoverFromEmptyResponse(
    deps,
    state,
    input,
    decision,
    request,
    response.assembled.finishReason,
    routedMaxOutputTokens,
  );
  if (recovery === "recovered-return") {
    return { kind: "continue" };
  }
  if (recovery !== "unhandled") {
    return recovery;
  }

  const status = createEmptyResponseStatus({
    provider: request.provider,
    model: request.model,
    attempts: 2,
  });
  yield await emitStatus(input, status);
  const result = createTurnResult(input, {
    type: "success",
    stopReason: "completed",
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    turns: state.turnCount,
    startedAt: state.startedAt,
    finalMessage: state.messages.filter(m => m.role === "assistant").at(-1),
  });
  return yield* terminateTurn(deps, input, state, result, { errored: true });
}

/**
 * 装配链调度入口：装配 → 三条互斥异常处置 → 正常落库。全部处置 unhandled
 * 表示响应可用，交回主循环执行工具调用或收尾。
 */
export async function* assembleAndRecover(
  deps: ResponseAssemblyDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  request: CanonicalModelRequest,
  decision: RouterDecision,
  routedMaxOutputTokens: number | undefined,
  assembler: ReturnType<typeof createModelMessageAssemblerState>,
): AsyncGenerator<AgentEvent, ResponseAssemblyOutcome, unknown> {
  const assembled = assembleAssistantMessage(assembler);
  state.usage = mergeUsage(state.usage, assembled.usage);
  state.lastModelUsage = assembled.usage;
  const response: AssembledResponse = {
    assembled,
    assistantMessage: assembled.message,
    toolCalls: collectToolCalls(assembled.message),
  };
  if (assembled.hasTextFallbackToolCalls) {
    const repaired = repairTextExtractedToolNames(deps, response.assistantMessage, response.toolCalls);
    response.assistantMessage = repaired.message;
    response.toolCalls = repaired.toolCalls;
  }
  state.finalMessage = response.assistantMessage;
  state.expireConsumedTransientPrompts();
  const fatalReason = recordModelCall(deps.doomLoop, response.assistantMessage, input, deps.eventEmitter);
  if (fatalReason) state.doomLoopFatalReason = fatalReason;

  if (assembled.error) {
    // 错误路径（含 streamInterruption）由主循环转交
    // modelErrorRecovery.recoverFromModelError 恢复/终止。这里不得在正常路径
    // 落库/emit 未经验证的 assistantMessage——它可能含半截工具调用（如完整文本
    // 回退解析出的 tool_call 块），恢复响应到达前被取消时绝不能持久化。
    return { kind: "proceed", ...response };
  }

  // 未知 finishReason（有 message_end 但未映射）：视为正常完成。OpenAI
  // 兼容代理/本地推理服务常返回未枚举的 finish_reason（eos_token 等），
  // 其响应内容（文本/工具调用）是完整的——注入恢复提示会把每次成功响应
  // 拖入恢复链并在 2 次后使整个 turn 失败。真正的断流由 streamInterruption
  // 错误路径覆盖，空响应由下方 empty-response 恢复链处理。
  // 正常装配即视为恢复成功：连续中断计数在此清零，与 unknownFinish 恢复
  // 语义对称——恢复流成功产出后下一次可独立恢复的中断重新计数。
  state.streamInterruptionRecoveryCount = 0;

  const partial = yield* handlePartialTextToolCall(deps, state, input, response);
  if (partial.kind !== "unhandled") return partial;

  const repairedTruncation = yield* handleRepairedTruncation(
    deps,
    state,
    input,
    decision,
    routedMaxOutputTokens,
    response,
  );
  if (repairedTruncation.kind !== "unhandled") return repairedTruncation;

  const empty = yield* handleEmptyResponse(deps, state, input, request, decision, routedMaxOutputTokens, response);
  if (empty.kind !== "unhandled") return empty;

  state.messages.push(response.assistantMessage);
  yield {
    type: "assistant_message",
    sessionId: input.sessionId,
    turnId: input.turnId,
    message: response.assistantMessage,
  };
  await input.onDurableMessage?.(response.assistantMessage);

  return { kind: "proceed", ...response };
}
