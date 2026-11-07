/**
 * 模型流式响应阶段（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 顺序即语义：request_header 快照落盘 → 上下文快照 → 逐事件转发并喂给
 * assembler →（可选）派发点对拍 → 异常/取消收尾 → 成功交回 assembler。
 * 错误文案与事件顺序一字不动（对拍口径见 #360）。
 */

import {
  applyModelEventToAssembler,
  createModelMessageAssemblerState,
  ModelProviderError,
  type CanonicalModelRequest,
} from "../../../model/index.js";
import type { RouterDecision, RouterDispatchReport } from "../../../router/index.js";
import { createModelContextSnapshot } from "../../../session/context/ModelContextSnapshot.js";
import type { AgentEvent } from "../../protocol/events.js";
import { agentError } from "../../protocol/errors.js";
import type { AgentLoopInput } from "../../protocol/input.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../runtime/AgentRuntimeDependencies.js";
import type { LifecycleDispatcher } from "../misc.js";
import { createModelRequestFailedStatus } from "../modelErrors.js";
import { buildRequestHeaderSnapshot, verifyDispatchedRequest } from "../requestInvariant.js";
import {
  abortTurn,
  buildTurnResult,
  captureAbortedPartial,
  createAbortStatus,
  emitStatus,
  terminateTurn,
  type TurnExitDeps,
  type TurnStepReturn,
} from "../turnExit.js";
import type { TurnRuntimeState } from "../turnRuntimeState.js";

export type StreamModelResponseResult =
  | TurnStepReturn
  | { kind: "continue"; assembler: ReturnType<typeof createModelMessageAssemblerState> };

/** 流式响应阶段依赖袋（AgentLoop 组装注入）。 */
export interface StreamResponseDeps extends TurnExitDeps {
  readonly config: AgentRuntimeConfig;
  readonly dependencies: AgentRuntimeDependencies;
  readonly dispatchLifecycle: LifecycleDispatcher;
}

export async function* streamModelResponse(
  deps: StreamResponseDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  request: CanonicalModelRequest,
  decision: RouterDecision,
): AsyncGenerator<AgentEvent, StreamModelResponseResult, unknown> {
  // 阶段四 T2：发送前落 request_header 快照（log-only，供审计与重建对拍）。
  // 写入失败即中止本步（fail-closed：无法记录请求头就不发送）。
  const requestHeader = buildRequestHeaderSnapshot(request, decision);
  await input.onRequestHeader?.(requestHeader);
  await input.onModelContext?.(createModelContextSnapshot(request, input.turnId));
  // 对拍不在此处做：旧实现在这里用同一对 (request, decision) 自比，恒真（#360）。
  // 现改为在**派发点**对拍（下方 onDispatchRequest），两侧不同源方能有牙齿。
  const verifyDispatch = process.env.SATI_VERIFY_REQUEST_RECONSTRUCTION === "1";
  const assembler = createModelMessageAssemblerState();
  try {
    for await (const event of deps.dependencies.router.execute(decision, request, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      projectPath: deps.config.cwd,
      abortSignal: input.abortSignal,
      // 生产判据（#360）：实际派发形态 vs 发送前落盘的快照，差异只允许落在
      // 本次派发的改写标签声明过的字段内；未声明的改写在此 fail-loud。
      ...(verifyDispatch
        ? {
            onDispatchRequest: (report: RouterDispatchReport): void => {
              verifyDispatchedRequest({ persisted: requestHeader, report });
            },
          }
        : {}),
    })) {
      yield { type: "model_event", sessionId: input.sessionId, turnId: input.turnId, event };
      applyModelEventToAssembler(assembler, event);
      if (event.type === "error") {
        break;
      }
    }
    if (!state.stickyInfo?.orchestrating) state.previousTier = undefined;
  } catch (error) {
    if (input.abortSignal?.aborted) {
      yield* captureAbortedPartial(state, input, assembler);
      return yield* abortTurn(deps, input, state);
    }
    const modelError = error instanceof ModelProviderError ? error.error : undefined;
    const stopFailureMsg = modelError?.message ?? (error instanceof Error ? error.message : String(error));
    await deps.dispatchLifecycle(input, "StopFailure", { error: stopFailureMsg });
    yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: stopFailureMsg };
    const result = buildTurnResult(
      input,
      {
        type: "error",
        stopReason: "model_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        errors: [agentError("agent_model_error", stopFailureMsg, modelError, modelError?.userHint)],
      },
      deps.now(),
    );
    const abortStatus = createAbortStatus(input);
    if (abortStatus) {
      yield await emitStatus(input, abortStatus);
    } else {
      yield await emitStatus(
        input,
        createModelRequestFailedStatus({
          error: result.errors![0]!,
          modelError,
        }),
      );
    }
    return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
  }

  if (input.abortSignal?.aborted) {
    yield* captureAbortedPartial(state, input, assembler);
    return yield* abortTurn(deps, input, state);
  }

  return { kind: "continue", assembler };
}
