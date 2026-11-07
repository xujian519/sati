/**
 * turn 起始守门阶段（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 顺序即语义：取消检查 → doomLoop 致命状态 → PreStep 生命周期扩展点。
 * 任一步终止 turn 即返回 `TurnStepReturn`，否则交回主回路继续下一阶段。
 */

import type { AgentEvent } from "../../protocol/events.js";
import { agentError } from "../../protocol/errors.js";
import type { AgentLoopInput } from "../../protocol/input.js";
import { findLifecycleBlock, type LifecycleDispatcher } from "../misc.js";
import { createLifecycleBlockedStatus } from "../modelErrors.js";
import {
  abortTurn,
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "../turnExit.js";
import type { TurnRuntimeState } from "../turnRuntimeState.js";

export type TurnGuardsResult = TurnStepContinue | TurnStepReturn;

/** turn 守门阶段依赖袋（AgentLoop 组装注入）。 */
export interface TurnGuardsDeps extends TurnExitDeps {
  readonly dispatchLifecycle: LifecycleDispatcher;
}

export async function* runTurnGuards(
  deps: TurnGuardsDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
): AsyncGenerator<AgentEvent, TurnGuardsResult, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  if (input.abortSignal?.aborted) {
    return yield* abortTurn(deps, input, state);
  }

  if (state.doomLoopFatalReason !== undefined) {
    const result = createTurnResult(input, {
      type: "error",
      stopReason: "model_error",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: state.turnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
      errors: [agentError("agent_doomloop", state.doomLoopFatalReason)],
    });
    return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
  }

  // PreStep 扩展点：turn 开始、模型请求组装前（对应 dsh pre-step 瀑布）。
  // 钩子返回的 messages 追加到本轮模型可见消息（改写）；blockingErrors 中
  // 的 block 效果终止 turn（拒绝）。无钩子注册时 dispatch 返回空结果，零开销。
  const preStep = await deps.dispatchLifecycle(input, "PreStep", {
    messages: state.messages,
    turnCount: state.turnCount,
  });
  if (preStep.messages.length > 0) {
    state.messages.push(...preStep.messages);
  }
  const preStepBlock = findLifecycleBlock(preStep);
  if (preStepBlock) {
    const result = createTurnResult(input, {
      type: "error",
      stopReason: "tool_error",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: state.turnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
      structuredOutput: state.structuredOutput,
      errors: [agentError("agent_unsupported_feature", preStepBlock.reason)],
    });
    yield await emitStatus(
      input,
      createLifecycleBlockedStatus({
        error: result.errors![0]!,
        stage: "pre_step",
      }),
    );
    return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
  }

  return { kind: "continue" };
}
