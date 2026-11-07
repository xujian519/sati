/**
 * turn 收尾阶段（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 顺序即语义：结构化输出即停 → maxTurns 上限 → 进入下一轮（turn_continued）。
 * 只读 config，不持有实例状态（now/tokenCaps/context 由 deps 注入）。
 */

import type { AgentEvent } from "../../protocol/events.js";
import { agentError } from "../../protocol/errors.js";
import type { AgentLoopInput } from "../../protocol/input.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import { createMaxTurnsStatus, createStructuredOutputCompletedStatus } from "../modelErrors.js";
import {
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "../turnExit.js";
import type { TurnRuntimeState } from "../turnRuntimeState.js";

export type FinishTurnResult = TurnStepContinue | TurnStepReturn;

/** turn 收尾阶段依赖袋（AgentLoop 组装注入）。 */
export interface FinishTurnDeps extends TurnExitDeps {
  readonly config: AgentRuntimeConfig;
}

export async function* finishTurn(
  deps: FinishTurnDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
): AsyncGenerator<AgentEvent, FinishTurnResult, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  if (deps.config.stopOnStructuredOutput && state.structuredOutput !== undefined) {
    const result = createTurnResult(input, {
      type: "success",
      stopReason: "completed",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: state.turnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
      structuredOutput: state.structuredOutput,
    });
    const status = createStructuredOutputCompletedStatus();
    yield await emitStatus(input, status);
    return yield* terminateTurn(deps, input, state, result);
  }

  const nextTurnCount = state.turnCount + 1;
  if (input.maxTurns && nextTurnCount > input.maxTurns) {
    const maxTurnsError = agentError(
      "agent_max_turns_reached",
      `Reached maximum number of turns (${input.maxTurns}).`,
      undefined,
      "Max turn limit reached. Increase maxTurns in config or break the task into smaller steps.",
    );
    const result = createTurnResult(input, {
      type: "max_turns",
      stopReason: "max_turns",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: nextTurnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
      structuredOutput: state.structuredOutput,
      errors: [maxTurnsError],
    });
    const status = createMaxTurnsStatus({ maxTurns: input.maxTurns, error: maxTurnsError });
    yield await emitStatus(input, status);
    return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
  }

  state.turnCount = nextTurnCount;
  yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "next_turn" };
  return { kind: "continue" };
}
