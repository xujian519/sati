/**
 * 模型请求准备阶段（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 顺序即语义：pre-routing 自动压缩 → 请求装配 → 取消检查 → PreModelRequest
 * 生命周期（fire-and-forget）→ model_request_started → 路由判定 → 按路由模型
 * 上下文窗口补一次 post-routing 压缩 → token caps → context_budget 事件。
 */

import type { CanonicalModelRequest } from "../../../model/index.js";
import type { AgentEvent } from "../../protocol/events.js";
import type { RouterDecision } from "../../../router/index.js";
import type { AgentLoopInput } from "../../protocol/input.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../runtime/AgentRuntimeDependencies.js";
import type { TokenBudgetSnapshot } from "../../../context/index.js";
import { createLogger } from "../../../telemetry/index.js";
import { runAutoCompact } from "../compactionExecutor.js";
import { createBudgetEvaluator, createModelRequest, type ModelRequestDeps } from "../modelRequest.js";
import type { LifecycleDispatcher } from "../misc.js";
import type { SubagentExecutor } from "../subagentExecutor.js";
import { abortTurn, type TurnExitDeps, type TurnStepReturn } from "../turnExit.js";
import type { TurnRuntimeState } from "../turnRuntimeState.js";

const agentLogger = createLogger("agent");

export type PrepareModelCallResult =
  | TurnStepReturn
  | {
      kind: "continue";
      request: CanonicalModelRequest;
      decision: RouterDecision;
      routedMaxOutputTokens: number | undefined;
    };

/** 模型请求准备阶段依赖袋（AgentLoop 组装注入）。 */
export interface ModelCallDeps extends TurnExitDeps {
  readonly config: AgentRuntimeConfig;
  readonly dependencies: AgentRuntimeDependencies;
  readonly dispatchLifecycle: LifecycleDispatcher;
  readonly modelRequest: ModelRequestDeps;
  readonly subagentExecutor: SubagentExecutor;
}

export async function* prepareModelCall(
  deps: ModelCallDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
): AsyncGenerator<AgentEvent, PrepareModelCallResult, unknown> {
  let pendingContextBudget: TokenBudgetSnapshot | undefined;
  const ctx = deps.dependencies.context;
  const preRoutingMaxContextTokens = deps.tokenCaps.currentMaxContextTokens(deps.config.provider, deps.config.model);
  if (ctx?.tryAutoCompact) {
    const reservedOutputTokens = deps.tokenCaps.getReservedOutputTokens();
    const compact = yield* runAutoCompact(deps.dependencies.context, state, input, {
      stage: "pre-routing",
      reservedOutputTokens,
      budgetEvaluator: createBudgetEvaluator(deps.modelRequest, input, {
        maxContextTokens: preRoutingMaxContextTokens,
        reservedOutputTokens,
      }),
    });
    pendingContextBudget = compact.snapshot;
    yield* deps.subagentExecutor.drainEventBuffer();
  }

  let request = await createModelRequest(deps.modelRequest, state.messages, input, { state });
  if (input.abortSignal?.aborted) {
    return yield* abortTurn(deps, input, state);
  }
  deps
    .dispatchLifecycle(input, "PreModelRequest", {
      provider: request.provider,
      model: request.model,
    })
    .catch(error => agentLogger.warn("PreModelRequest lifecycle dispatch failed:", error));
  yield {
    type: "model_request_started",
    sessionId: input.sessionId,
    turnId: input.turnId,
    model: request.model,
    provider: request.provider,
  };

  // Split decide + execute so we can insert a post-routing compact pass
  // when the routed model's context window differs from the agent's
  // default model (the window used by the first tryAutoCompact above).
  let decision: RouterDecision;
  try {
    decision = await deps.dependencies.router.decide({
      request,
      sessionId: input.sessionId,
      isMainAgent: !deps.config.isSubagent,
      // 取消回合时同步中止在途的路由判官：否则判官要跑满超时才返回，为一个
      // 已取消的回合发出降级事件并白白占用一次 judge 调用。
      abortSignal: input.abortSignal,
      metadata: state.stickyInfo
        ? {
            previousTier: state.previousTier,
            previousProvider: state.stickyInfo.previousProvider,
            previousModel: state.stickyInfo.previousModel,
          }
        : state.previousTier
          ? { previousTier: state.previousTier }
          : undefined,
    });
  } catch (error) {
    // decide 会把中止原因原样抛出（RouterRuntime 的 abort 重抛语义）；按取消
    // 收尾，而不是让取消被记成一次路由失败。
    if (input.abortSignal?.aborted) {
      return yield* abortTurn(deps, input, state);
    }
    throw error;
  }
  const routedLimits = deps.tokenCaps.getModelTokenLimits(decision.provider, decision.model);
  const routedMaxOutputTokens = routedLimits?.maxOutputTokens;

  let emittedContextBudget = false;
  if (ctx?.tryAutoCompact) {
    const routedMaxCtx = deps.tokenCaps.currentMaxContextTokens(decision.provider, decision.model);
    const currentBudgetMaxCtx = preRoutingMaxContextTokens;
    if (routedMaxCtx !== undefined && routedMaxCtx !== currentBudgetMaxCtx) {
      const reservedOutputTokens = deps.tokenCaps.getReservedOutputTokens(decision.provider, decision.model);
      const recompact = yield* runAutoCompact(deps.dependencies.context, state, input, {
        stage: "post-routing",
        maxContextTokens: routedMaxCtx,
        reservedOutputTokens,
        budgetEvaluator: createBudgetEvaluator(deps.modelRequest, input, {
          decision,
          baseRequest: request,
          maxContextTokens: routedMaxCtx,
          reservedOutputTokens,
        }),
      });
      if (recompact.compacted) {
        request = await createModelRequest(deps.modelRequest, state.messages, input, { state });
        request = deps.tokenCaps.applyTokenCapsToRequest(request, decision.provider, decision.model);
      }
      if (recompact.snapshot !== undefined) {
        yield {
          type: "context_budget",
          sessionId: input.sessionId,
          turnId: input.turnId,
          snapshot: recompact.snapshot,
        };
        emittedContextBudget = true;
      }
    }
  }
  request = deps.tokenCaps.applyTokenCapsToRequest(request, decision.provider, decision.model);
  deps.tokenCaps.clearAttemptOutputTokenCap(decision.provider, decision.model);
  if (pendingContextBudget && !emittedContextBudget) {
    yield {
      type: "context_budget",
      sessionId: input.sessionId,
      turnId: input.turnId,
      snapshot: pendingContextBudget,
    };
  }

  return { kind: "continue", request, decision, routedMaxOutputTokens };
}
