/**
 * 工具调用执行阶段（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 负责：工具执行前 durable checkpoint → 并发执行（含子代理事件泵）→ 结果配对/
 * 失败标注/doomLoop 记录 → 逐个 emit tool_result 并处理 mode 切换 → 经 context
 * runtime 投影落库 → LargeFileRepair 续跑或生命周期阻断。纯编排，不做恢复决策
 * （电路断路器仍在主回路）。
 */

import type { AssembledAssistantMessage, CanonicalMessage, CanonicalToolCall } from "../../model/index.js";
import type { SatiToolResult } from "../../tool/protocol/result.js";
import type { PermissionMode } from "../../permission/index.js";
import type { AgentEvent } from "../protocol/events.js";
import { agentError } from "../protocol/errors.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { recordToolResults } from "./doomLoopIntegration.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import { bindSupplementalMessagesToToolCalls, findToolLifecycleBlock, readRequestedMode } from "./misc.js";
import { createLifecycleBlockedStatus } from "./modelErrors.js";
import { projectToolResults } from "./projectToolResults.js";
import {
  buildRepeatReminderMessage,
  REPEAT_REMINDER_THRESHOLD,
  type RepeatTracker,
  toolCallKey,
} from "./repeatToolReminder.js";
import type { SyntheticPromptContinuer } from "./responseAssembly.js";
import type { SubagentExecutor } from "./subagentExecutor.js";
import type { ToolContextFactory } from "./toolContext.js";
import { annotateRepeatedToolFailures, collectPermissionDenials, detectRepeatedToolFailure } from "./toolFailure.js";
import {
  abortTurn,
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "./turnExit.js";
import type { TurnRuntimeState } from "./turnRuntimeState.js";

export type ExecuteToolCallsResult =
  | TurnStepReturn
  | TurnStepContinue
  | { kind: "proceed"; pairedResults: SatiToolResult[] };

/** 工具执行阶段依赖袋（AgentLoop 组装注入）。 */
export interface ToolCallExecutionDeps extends TurnExitDeps {
  readonly config: AgentRuntimeConfig;
  readonly toolContextFactory: ToolContextFactory;
  readonly subagentExecutor: SubagentExecutor;
  readonly repeatTracker: RepeatTracker;
  readonly doomLoop: AgentRuntimeDependencies["doomLoop"];
  readonly eventEmitter: AgentRuntimeDependencies["eventEmitter"];
  readonly context: AgentRuntimeDependencies["context"];
  readonly missingToolResultRecoveryContext: () => { cwd: string; permissionMode: PermissionMode };
  readonly continueWithSyntheticPrompt: SyntheticPromptContinuer;
}

export async function* executeToolCalls(
  deps: ToolCallExecutionDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  toolCalls: CanonicalToolCall[],
  assembled: AssembledAssistantMessage,
): AsyncGenerator<AgentEvent, ExecuteToolCallsResult, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  yield { type: "tool_calls_detected", sessionId: input.sessionId, turnId: input.turnId, calls: toolCalls };
  if (input.abortSignal?.aborted) {
    return yield* abortTurn(deps, input, state);
  }

  // 阶段四 T4.1：durable 边界检查点——工具副作用（写文件/外呼/子代理）执行
  // 前强制刷新转录落盘。失败即中止本步（fail-closed：无法保证持久边界就不
  // 发生副作用）。调用方未接 flushCheckpoint 时是 no-op。
  await input.onFlushCheckpoint?.();

  let results: SatiToolResult[];
  try {
    const toolContext = deps.toolContextFactory.createToolContext(input);
    if (assembled.finishReason === "length" || assembled.hasRepairedToolCalls) {
      toolContext.outputTruncated = true;
    }
    results = yield* deps.subagentExecutor.executeToolsWithEventPump(toolCalls, toolContext, input);
  } catch (error) {
    results = toolCalls.map(call =>
      createMissingToolResult(
        call,
        deps.now,
        error instanceof Error ? error.message : String(error),
        deps.missingToolResultRecoveryContext(),
      ),
    );
  }
  if (input.abortSignal?.aborted) {
    return yield* abortTurn(deps, input, state);
  }
  yield* deps.subagentExecutor.drainEventBuffer();

  // 压缩空转判据：一批工具调用执行完即算一次真实工具轮——无论成败，它都是
  // 「模型试图推进」的证据（工具全错时压缩并不因此有理）。
  deps.context?.noteToolTurn?.();

  // 阶段四 T6.2：连续重复软提醒——达到阈值（默认 3 次）后向下一轮请求
  // 注入一次 transient advisory（不拦截；doomLoop 仍是硬断开）。
  for (const call of toolCalls) {
    const count = deps.repeatTracker.record(toolCallKey(call.name, call.input));
    if (count === REPEAT_REMINDER_THRESHOLD) {
      state.messages = [...state.messages, buildRepeatReminderMessage(call.name, count)];
    }
  }

  let pairedResults = ensureToolResultPairing(
    toolCalls,
    results,
    deps.now,
    "Tool execution did not produce a result.",
    deps.missingToolResultRecoveryContext(),
  );
  const repeatedFailure = detectRepeatedToolFailure(pairedResults, state.lastToolFailureFingerprint);
  pairedResults = annotateRepeatedToolFailures(pairedResults, repeatedFailure.repeatedKeys);
  state.lastToolFailureFingerprint = repeatedFailure.currentFingerprint;
  const toolFatalReason = recordToolResults(deps.doomLoop, toolCalls, pairedResults, input, deps.eventEmitter);
  if (toolFatalReason) state.doomLoopFatalReason = toolFatalReason;
  const toolResultRepair = state.largeFileRepair.analyzeToolResults(pairedResults, {
    outputTruncated: assembled.finishReason === "length" || assembled.hasRepairedToolCalls === true,
    repairedToolCalls: assembled.hasRepairedToolCalls === true,
    finishReason: assembled.finishReason,
  });
  state.permissionDenials = [...state.permissionDenials, ...collectPermissionDenials(pairedResults)];
  for (const result of pairedResults) {
    // 声称-行动守卫：累积本 run 内成功执行的工具名（供 claimGuard 校验支撑）。
    if (result.type === "success") {
      state.succeededToolNames.push(result.toolName);
    }
    if (result.type === "success" && result.metadata?.structuredOutput) {
      state.structuredOutput = result.data;
    }
    const requestedMode = readRequestedMode(result.type === "success" ? result.data : undefined);
    if (requestedMode) {
      let effectiveMode = requestedMode;

      if (requestedMode === "plan" && deps.config.permissionMode !== "plan") {
        deps.config.permissionModeBeforePlan = deps.config.permissionMode;
      } else if (deps.config.permissionMode === "plan" && requestedMode !== "plan") {
        if (deps.config.permissionModeBeforePlan) {
          effectiveMode = deps.config.permissionModeBeforePlan;
          deps.config.permissionModeBeforePlan = undefined;
        }
      }

      deps.config.permissionMode = effectiveMode;
      deps.config.permissionContext.mode = effectiveMode;
      yield {
        type: "mode_change_requested",
        sessionId: input.sessionId,
        turnId: input.turnId,
        mode: effectiveMode,
      };
    }
    yield { type: "tool_result", sessionId: input.sessionId, turnId: input.turnId, result };
  }

  const projected = projectToolResults(pairedResults);
  // Route the freshly projected tool_result message through the context
  // runtime so large payloads land on disk via `ToolResultBudget`. When
  // the runtime doesn't implement `applyToolResults` (e.g. NullContext),
  // we simply append the raw projection (legacy behaviour).
  const [toolResultMsg, ...supplementalMsgs] = projected;
  const supplementalInputs = bindSupplementalMessagesToToolCalls(pairedResults, supplementalMsgs);
  let appendedMessages: CanonicalMessage[] = projected;
  const ctxApply = deps.context?.applyToolResults;
  if (ctxApply) {
    try {
      const applied = await ctxApply.call(deps.context, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolResultMessage: toolResultMsg,
        supplementalMessages: supplementalInputs,
        messages: state.messages,
      });
      state.messages = applied.messages;
      appendedMessages = applied.appendedMessages ?? projected;
    } catch {
      // applyToolResults 失败（如 spill 落盘错误）：回退原始投影，保证工具结果不丢。
      state.messages.push(...projected);
    }
  } else {
    state.messages.push(...projected);
  }
  for (const appended of appendedMessages) {
    yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: appended };
    await input.onDurableMessage?.(appended);
  }

  if (toolResultRepair) {
    const continued = await deps.continueWithSyntheticPrompt(state, input, toolResultRepair);
    if (continued.type === "completed") {
      if (continued.status) {
        yield await emitStatus(input, continued.status);
      }
      return yield* terminateTurn(deps, input, state, continued.result, { emitFailureEvent: true });
    }
    yield continued.event;
    return { kind: "continue" };
  }

  const lifecycleBlock = findToolLifecycleBlock(pairedResults);
  if (lifecycleBlock) {
    const result = createTurnResult(input, {
      type: "error",
      stopReason: "tool_error",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: state.turnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
      structuredOutput: state.structuredOutput,
      errors: [agentError("agent_unsupported_feature", lifecycleBlock.reason)],
    });
    yield await emitStatus(
      input,
      createLifecycleBlockedStatus({
        error: result.errors![0]!,
        stage: "tool_lifecycle",
      }),
    );
    return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
  }

  return { kind: "proceed", pairedResults };
}
