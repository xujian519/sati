/**
 * 电路断路器阶段（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 只处理「本轮工具结果全为 invalid_tool_input」的重复失败：LargeFileRepair
 * 待修优先续跑；否则按指纹累计，达阈值先给一轮宽限提示，再达阈值即终止；
 * 非全失败轮次则复位各类恢复计数。
 */

import type { SatiToolResult } from "../../../tool/protocol/result.js";
import type { AgentEvent } from "../../protocol/events.js";
import { agentError } from "../../protocol/errors.js";
import type { AgentLoopInput } from "../../protocol/input.js";
import { createToolErrorLoopStatus } from "../modelErrors.js";
import { continueWithTransientPrompt } from "../recoveryStrategies.js";
import type { SyntheticPromptContinuer } from "../responseAssembly.js";
import { buildInvalidFingerprint } from "../toolFailure.js";
import {
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "../turnExit.js";
import { MAX_SAME_INVALID_FINGERPRINT, type TurnRuntimeState } from "../turnRuntimeState.js";

const CIRCUIT_BREAKER_GRACE_PROMPT = [
  "Your last several tool calls all failed input validation with the same error.",
  "This may indicate a tool-side issue rather than a problem with your approach.",
  "Options: (1) try a different tool or different parameters,",
  "(2) explain the situation in text without calling tools,",
  "(3) if you believe the tool should work, try once more with corrected input.",
].join(" ");

export type CircuitBreakerResult = TurnStepContinue | TurnStepReturn;

/** 电路断路器阶段依赖袋（AgentLoop 组装注入）。 */
export interface CircuitBreakerDeps extends TurnExitDeps {
  readonly continueWithSyntheticPrompt: SyntheticPromptContinuer;
}

export async function* handleCircuitBreaker(
  deps: CircuitBreakerDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  pairedResults: SatiToolResult[],
): AsyncGenerator<AgentEvent, CircuitBreakerResult, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  const allInvalid =
    pairedResults.length > 0 && pairedResults.every(r => r.type === "error" && r.error.code === "invalid_tool_input");
  if (allInvalid && state.largeFileRepair.hasPendingRepair) {
    const fallbackRepair = state.largeFileRepair.onInvalidToolInput();
    if (fallbackRepair) {
      const continued = await deps.continueWithSyntheticPrompt(state, input, fallbackRepair);
      if (continued.type === "completed") {
        if (continued.status) {
          yield await emitStatus(input, continued.status);
        }
        return yield* terminateTurn(deps, input, state, continued.result, { emitFailureEvent: true });
      }
      yield continued.event;
      return { kind: "continue" };
    }
  }
  if (allInvalid) {
    const fingerprint = buildInvalidFingerprint(pairedResults);
    if (fingerprint === state.lastInvalidFingerprint) {
      state.sameInvalidFingerprintCount++;
    } else {
      state.sameInvalidFingerprintCount = 1;
      state.lastInvalidFingerprint = fingerprint;
      state.hasUsedInvalidGracePeriod = false;
    }

    if (state.sameInvalidFingerprintCount >= MAX_SAME_INVALID_FINGERPRINT) {
      if (!state.hasUsedInvalidGracePeriod) {
        state.hasUsedInvalidGracePeriod = true;
        return yield* continueWithTransientPrompt(state, input, CIRCUIT_BREAKER_GRACE_PROMPT, "circuit_breaker_grace");
      }

      const result = createTurnResult(input, {
        type: "error",
        stopReason: "tool_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [
          agentError(
            "agent_tool_error_loop",
            `Terminated: ${state.sameInvalidFingerprintCount} consecutive turns with identical tool input validation failures (same tool + same error). The model appears stuck in a loop.`,
            undefined,
            "The model is repeatedly producing invalid tool calls. Consider switching to a more capable model via settings.",
          ),
        ],
      });
      yield await emitStatus(
        input,
        createToolErrorLoopStatus({
          error: result.errors![0]!,
          repeatedFailures: state.sameInvalidFingerprintCount,
        }),
      );
      return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
    }
  } else {
    state.sameInvalidFingerprintCount = 0;
    state.lastInvalidFingerprint = undefined;
    state.hasUsedInvalidGracePeriod = false;
    if (!pairedResults.some(r => r.type === "error")) {
      state.lastToolFailureFingerprint = undefined;
    }
    state.maxOutputRecoveryCount = 0;
    state.consecutiveEmptyCount = 0;
    state.hasAttemptedOutputRetry = false;
    state.hasAttemptedEmptyRetry = false;
    state.hasAttemptedToolCallRetry = false;
  }

  return { kind: "continue" };
}
