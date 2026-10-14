import type { CanonicalModelError, CanonicalModelRequest, InputModality, ModelRuntime } from "../../model/index.js";
import {
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
  LITELLM_RETRY_JITTER,
} from "../../model/streaming/streamModel.js";
import { computeBackoffDelay } from "../../shared/retry/index.js";
import type { RouterConfig, RouterModelRef } from "../config/schema.js";
import { isFallbackEligible, planFallback } from "../fallback/runFallbackChain.js";
import { downgradeRequestForAttempt, supportsMediaRequirements } from "../media/modelMediaSupport.js";
import type { RouterDecision } from "../protocol/decision.js";
import { shouldTransientRetry, shouldZeroUsageRetry } from "../retry/retryGates.js";
import { stripSubagentTagFromMessages } from "../scenario/subagentDetector.js";
import { countMessagesTokens } from "../utils/countTokens.js";
import { collectRequiredInputModalities } from "../utils/mediaRequirements.js";
import type { AttemptOutcome } from "./streamAttempt.js";

/**
 * 一次路由决策的**纯规划与判定**：#646 sweep P2.6 把 `executeRouterDecision` 的
 * 「决策 → 请求装配」与「attempt 结局 → 下一步动作」两段判定从编排体里外置到此。
 *
 * 本模块无 IO：不 emit、不打点、不落账、不 sleep、不 yield——那些留在
 * `attemptReporting.ts` 与编排体内。因此这里的每个函数都可用普通单测直测，
 * 而 `executeRouterDecision` 只剩「取值 → 判定 → 上报 → 推进」的编排骨架。
 */

export type AttemptPlan = {
  attempt: RouterModelRef;
  downgradeUnsupportedMedia: boolean;
};

/** 三套重试的预算（执行期常量，来自 `RouterConfig`）。 */
export type AttemptRetryBudget = {
  zeroUsage: { enabled: boolean; maxAttempts: number };
  transient: { enabled: boolean; maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
};

export type AttemptExecutionPlan = {
  /** 决策指定的 provider/model（fallback 链的队首）。 */
  requestedAttempt: RouterModelRef;
  /** 由决策后的请求推出的必需输入模态；决定哪些候选走媒体降级档。 */
  requiredModalities: readonly InputModality[];
  /** 执行序：先全能力候候选，再降级候选（原实现的 native → downgraded 两档）。 */
  attemptPlans: AttemptPlan[];
  retry: AttemptRetryBudget;
};

/**
 * attempt 的下一步动作。`terminalFailure` 表示「不再重试也不再回退」——
 * 编排体据此回放暂存帧并收尾；`success` 表示本次 attempt 的产物可交付。
 */
export type AttemptGate =
  | { kind: "fallback" }
  | { kind: "transientRetry"; delayMs: number }
  | { kind: "zeroUsageRetry"; delayMs: number }
  | { kind: "terminalFailure" }
  | { kind: "success" };

export function applyDecisionToRequest(
  decision: RouterDecision,
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
): CanonicalModelRequest {
  let messages = decision.requestPatch?.messages ?? request.messages;
  if (decision.mutations.subagentTagStripped) {
    messages = stripSubagentTagFromMessages(messages);
  }
  return clampMaxOutputTokensToModelCap(
    {
      ...request,
      ...decision.requestPatch,
      provider: decision.provider,
      model: decision.model,
      messages,
    },
    modelRuntime,
  );
}

export function clampMaxOutputTokensToModelCap(
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
): CanonicalModelRequest {
  const requested = request.maxOutputTokens;
  if (requested === undefined) {
    return request;
  }

  try {
    const cap = modelRuntime.getCapabilities(request.provider, request.model).maxOutputTokens;
    if (Number.isFinite(cap) && cap > 0 && requested > cap) {
      return { ...request, maxOutputTokens: cap };
    }
  } catch {
    // Unknown provider/model — let validateModelRequest surface the real error.
  }
  return request;
}

/** 候选分档 + 三套重试预算，一次算清（原 setup 段逐字搬入）。 */
export function planAttemptExecution(
  decision: RouterDecision,
  request: CanonicalModelRequest,
  config: RouterConfig,
  modelRuntime: ModelRuntime,
): AttemptExecutionPlan {
  const fallbackPlan = planFallback(config.fallback, decision.scenarioType);
  const baseRequest = applyDecisionToRequest(decision, request, modelRuntime);
  const requiredModalities = collectRequiredInputModalities(baseRequest.messages);
  const requestedAttempt: RouterModelRef = {
    id: `${decision.provider}/${decision.model}`,
    provider: decision.provider,
    model: decision.model,
  };
  const candidateAttempts: RouterModelRef[] = [requestedAttempt, ...fallbackPlan.attempts].filter(
    (attempt, index, all) =>
      all.findIndex(candidate => candidate.provider === attempt.provider && candidate.model === attempt.model) ===
      index,
  );
  const nativeAttempts: RouterModelRef[] = candidateAttempts.filter(attempt =>
    supportsMediaRequirements(attempt, requiredModalities, modelRuntime),
  );
  const downgradedAttempts: RouterModelRef[] =
    requiredModalities.length > 0
      ? candidateAttempts.filter(attempt => !supportsMediaRequirements(attempt, requiredModalities, modelRuntime))
      : [];
  const attemptPlans: AttemptPlan[] = [
    ...nativeAttempts.map(attempt => ({ attempt, downgradeUnsupportedMedia: false })),
    ...downgradedAttempts.map(attempt => ({ attempt, downgradeUnsupportedMedia: true })),
  ];
  return {
    requestedAttempt,
    requiredModalities,
    attemptPlans,
    retry: {
      zeroUsage: {
        enabled: config.zeroUsageRetry?.enabled ?? true,
        maxAttempts: Math.max(1, config.zeroUsageRetry?.maxAttempts ?? 5),
      },
      transient: {
        enabled: config.transientRetry?.enabled ?? true,
        maxAttempts: Math.max(1, config.transientRetry?.maxAttempts ?? LITELLM_DEFAULT_MAX_RETRIES),
        baseDelayMs: config.transientRetry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS,
        maxDelayMs: config.transientRetry?.maxDelayMs ?? LITELLM_MAX_RETRY_DELAY_MS,
      },
    },
  };
}

/** 某个 attempt 的决策与请求（fallback 档改 resolvedFrom；降级档过一遍媒体降级）。 */
export function planAttempt(
  decision: RouterDecision,
  plan: AttemptPlan,
  attemptIndex: number,
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
): { attemptDecision: RouterDecision; attemptRequest: CanonicalModelRequest } {
  const attemptDecision: RouterDecision = {
    ...decision,
    provider: plan.attempt.provider,
    model: plan.attempt.model,
    resolvedFrom: attemptIndex === 0 ? decision.resolvedFrom : "fallback",
  };
  let attemptRequest = applyDecisionToRequest(attemptDecision, request, modelRuntime);
  if (plan.downgradeUnsupportedMedia) {
    attemptRequest = downgradeRequestForAttempt(attemptRequest, plan.attempt, modelRuntime);
  }
  return { attemptDecision, attemptRequest };
}

/** 子代理预算判定：超限即返回可分派的错误（不发请求）。 */
export function subagentBudgetError(
  decision: RouterDecision,
  config: RouterConfig,
  attempt: RouterModelRef,
  request: CanonicalModelRequest,
  protocol: CanonicalModelError["protocol"],
): CanonicalModelError | undefined {
  if (!decision.isSubagent) {
    return undefined;
  }
  const budget = config.autoOrchestrate?.subagentMaxTokens;
  if (!budget) {
    return undefined;
  }
  const estimated = countMessagesTokens(request.messages);
  if (estimated <= budget) {
    return undefined;
  }
  return {
    provider: attempt.provider,
    protocol,
    code: "subagent_budget_exceeded",
    message: `Sub-agent budget exceeded (${estimated} estimated tokens > ${budget} limit).`,
    retryable: false,
    userHint:
      "Reduce the subagent prompt/context, increase the subagent token budget, or split the task into smaller steps.",
  };
}

/**
 * attempt 结局 → 下一步动作（原执行体内的 if 阶梯逐条搬入，判定顺序不变：
 * 回退 → 传输重试 → 终态；无错时：零用量重试 → 成功）。
 *
 * `delayMs` 在此算出（纯函数 `computeBackoffDelay`），上报与 sleep 由
 * `attemptReporting.ts` 执行——原实现里「算延迟」与「用延迟」相隔 40 行，
 * 拆开后延迟值只有一个来源。
 */
export function classifyAttemptGate(args: {
  outcome: AttemptOutcome;
  hasYieldedContent: boolean;
  attemptIndex: number;
  attemptCount: number;
  retry: AttemptRetryBudget;
  zeroUsageAttempt: number;
  transientRetryCount: number;
}): AttemptGate {
  const { outcome, retry } = args;
  if (outcome.error) {
    const fallbackEligible = isFallbackEligible(outcome.error);
    if (!args.hasYieldedContent && fallbackEligible && args.attemptIndex < args.attemptCount - 1) {
      return { kind: "fallback" };
    }
    if (
      shouldTransientRetry({
        hasYieldedContent: args.hasYieldedContent,
        fallbackEligible,
        enabled: retry.transient.enabled,
        retryCount: args.transientRetryCount,
        maxRetries: retry.transient.maxAttempts,
      })
    ) {
      return {
        kind: "transientRetry",
        delayMs: computeBackoffDelay(
          args.transientRetryCount,
          {
            baseMs: retry.transient.baseDelayMs,
            capMs: retry.transient.maxDelayMs,
            growth: "linear",
            jitterRatio: LITELLM_RETRY_JITTER,
          },
          outcome.error.retryAfterMs ?? undefined,
        ),
      };
    }
    return { kind: "terminalFailure" };
  }
  if (
    shouldZeroUsageRetry({
      hasYieldedContent: args.hasYieldedContent,
      enabled: retry.zeroUsage.enabled,
      attemptSaysRetry: outcome.shouldRetryZeroUsage,
      attempt: args.zeroUsageAttempt,
      maxAttempts: retry.zeroUsage.maxAttempts,
    })
  ) {
    return { kind: "zeroUsageRetry", delayMs: 500 * args.zeroUsageAttempt };
  }
  return { kind: "success" };
}
