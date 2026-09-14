/**
 * 共享恢复策略：transient 提示续跑、max-output 触顶的 Phase A/B、空响应前两级恢复。
 * 抽取自 AgentLoop（issue #147 / TD-AGENT-101）——此前在 assembleAndRecover、
 * handleModelError、handleNoToolCalls 各复制一份。
 */
import type { CanonicalModelRequest } from "../../model/index.js";
import type { RouterDecision } from "../../router/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { AgentLoopTransitionReason } from "../protocol/state.js";
import { stripTrailingErrorPair } from "./messages.js";
import { clampOutputToModelCap, createEmptyResponseStatus } from "./modelErrors.js";
import { resolveOutputTokenRetryBump } from "./outputTokenRetry.js";
import {
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "./turnExit.js";
import { MAX_CONSECUTIVE_EMPTY, MAX_OUTPUT_RECOVERY_LIMIT, type TurnRuntimeState } from "./turnRuntimeState.js";

const EMPTY_LENGTH_OUTPUT_RETRY_FLOOR = 4_096;

/**
 * 恢复路径的「注入 transient 提示并继续」：push 提示 + turn_continued
 * (model_error) + continue。此前 6+ 处逐字重复收敛于此。
 */
export async function* continueWithTransientPrompt(
  state: TurnRuntimeState,
  input: AgentLoopInput,
  prompt: string,
  purpose: string,
  reason: AgentLoopTransitionReason = "model_error",
): AsyncGenerator<AgentEvent, TurnStepContinue, unknown> {
  state.pushTransientSyntheticPrompt(prompt, purpose);
  yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason };
  return { kind: "continue" };
}

/**
 * 空响应恢复的 token 倍增（finishReason=length 时）：clamp 倍增（含 floor）
 * → 设置 transient cap → empty_output_recovery 事件。此前 4 处逐字重复。
 */
export async function* emitEmptyOutputTokenBump(
  deps: TurnExitDeps,
  input: AgentLoopInput,
  decision: RouterDecision,
  finishReason: string | undefined,
  routedMaxOutputTokens: number | undefined,
): AsyncGenerator<AgentEvent, void, unknown> {
  if (finishReason !== "length") return;
  const previousMaxOutputTokens = deps.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model);
  const nextMaxOutputTokens = clampOutputToModelCap(
    Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
    routedMaxOutputTokens,
  );
  if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
    deps.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
      requestedMaxOutputTokens: nextMaxOutputTokens,
    });
    yield {
      type: "empty_output_recovery",
      sessionId: input.sessionId,
      turnId: input.turnId,
      provider: decision.provider,
      model: decision.model,
      finishReason,
      previousMaxOutputTokens,
      nextMaxOutputTokens,
    };
  }
}

/**
 * 共享恢复策略：max-output 触顶的 Phase A（一次性 token 提升）与 Phase B
 * （截断续跑，至多 MAX_OUTPUT_RECOVERY_LIMIT 次）。原先在 assembleAndRecover 与
 * handleModelError 各复制一份（TD-AGENT-101）。
 *
 * 返回值约定：
 * - `"bumped"` / `"continuing"`：已产出续跑事件，调用方应结束本步并返回 continue；
 * - `"exhausted"`：A/B 均不可用，由调用方执行各自的 Phase C 兜底。
 *
 * `opts.stripTrailingErrorPairMessages` 仅 model-error 路径需要（错误对消息不得
 * 进入续跑上下文）；计数器与 try-flag 的推进顺序保持与原实现逐位一致。
 */
export async function* recoverFromMaxOutputBump(
  deps: TurnExitDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  decision: RouterDecision,
  routedMaxOutputTokens: number | undefined,
  opts: { stripTrailingErrorPairMessages?: boolean } = {},
): AsyncGenerator<AgentEvent, "bumped" | "continuing" | "exhausted", unknown> {
  // Phase A: token doubling (if not yet attempted)
  if (!state.hasAttemptedOutputRetry) {
    state.hasAttemptedOutputRetry = true;
    const nextMaxOutputTokens = resolveOutputTokenRetryBump({
      currentMaxOutputTokens: deps.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model),
      modelMaxOutputTokens: routedMaxOutputTokens,
    });
    if (nextMaxOutputTokens !== undefined) {
      if (opts.stripTrailingErrorPairMessages) {
        state.messages = stripTrailingErrorPair(state.messages);
      }
      const previousOutput = deps.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model);
      deps.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
        requestedMaxOutputTokens: nextMaxOutputTokens,
      });
      yield {
        type: "token_cap_adjusted",
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: decision.provider,
        model: decision.model,
        cap: "output",
        previous: previousOutput,
        next: nextMaxOutputTokens,
        reason: "max-output-retry-bump",
      };
      yield {
        type: "turn_continued",
        sessionId: input.sessionId,
        turnId: input.turnId,
        reason: "model_error",
      };
      return "bumped";
    }
  }

  // Phase B: continuation recovery
  if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
    state.maxOutputRecoveryCount++;
    yield* continueWithTransientPrompt(
      state,
      input,
      "Output token limit hit. Resume directly - no apology, no recap of what you were doing. " +
        "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
      "max_output_recovery",
    );
    return "continuing";
  }

  return "exhausted";
}

/**
 * 共享恢复策略：空响应（无错误、无工具调用、无可见文本）的前两级分支——
 * 连空递增恢复与首次可见文本重试。原先在 assembleAndRecover 与
 * handleNoToolCalls 各复制一份（TD-AGENT-101）。
 *
 * 返回值约定：
 * - `"recovered-return"`：已产出重试事件，调用方应返回 continue；
 * - `TurnStepReturn`：连空预算耗尽，本方法已完成终止仪式并透传其返回值，
 *   调用方应原样作为本步返回值；
 * - `"unhandled"`：首重预算也已耗尽，两个调用方的第三级兜底不同
 *   （assemble 走固定 attempts=2 终止；handleNoToolCalls 仅发状态后顺落正常收尾），
 *   故留在调用方。
 */
export async function* recoverFromEmptyResponse(
  deps: TurnExitDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  decision: RouterDecision,
  request: CanonicalModelRequest,
  assembledFinishReason: string | undefined,
  routedMaxOutputTokens: number | undefined,
): AsyncGenerator<AgentEvent, "recovered-return" | "unhandled" | TurnStepReturn, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  if (state.maxOutputRecoveryCount > 0) {
    state.consecutiveEmptyCount++;
    if (
      state.consecutiveEmptyCount < MAX_CONSECUTIVE_EMPTY &&
      state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT
    ) {
      state.maxOutputRecoveryCount++;
      yield* emitEmptyOutputTokenBump(deps, input, decision, assembledFinishReason, routedMaxOutputTokens);
      yield* continueWithTransientPrompt(
        state,
        input,
        "Output token limit hit. Resume directly - no apology, no recap of what you were doing. " +
          "Pick up mid-sentence if that is where the cut happened.",
        "max_output_recovery",
      );
      return "recovered-return";
    }
    // Exhausted consecutive empty retries — surface a UI-only status message
    // instead of injecting diagnostic assistant text into the model transcript.
    state.finalMessage = state.messages.filter(m => m.role === "assistant").at(-1);
    const status = createEmptyResponseStatus({
      provider: request.provider,
      model: request.model,
      attempts: state.consecutiveEmptyCount,
    });
    yield await emitStatus(input, status);
    const result = createTurnResult(input, {
      type: "success",
      stopReason: "completed",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: state.turnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
    });
    return yield* terminateTurn(deps, input, state, result, { errored: true });
  }

  if (!state.hasAttemptedEmptyRetry) {
    // First occurrence: prompt the model to produce visible output.
    state.hasAttemptedEmptyRetry = true;
    state.maxOutputRecoveryCount++;
    yield* emitEmptyOutputTokenBump(deps, input, decision, assembledFinishReason, routedMaxOutputTokens);
    yield* continueWithTransientPrompt(
      state,
      input,
      "Your previous response was empty (thinking only, no visible text). " +
        "Please provide your answer as visible text output.",
      "empty_response_retry",
    );
    return "recovered-return";
  }

  return "unhandled";
}
