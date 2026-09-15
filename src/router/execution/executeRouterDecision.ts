import type { CanonicalModelEvent, CanonicalModelRequest, ModelProtocol, ModelRuntime } from "../../model/index.js";
import type { InputModality } from "../../model/index.js";
import {
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
  LITELLM_RETRY_JITTER,
} from "../../model/streaming/streamModel.js";
import { computeBackoffDelay } from "../../shared/retry/index.js";
import { createLogger } from "../../telemetry/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { RouterConfig, RouterModelRef } from "../config/schema.js";
import { isFallbackEligible, planFallback } from "../fallback/runFallbackChain.js";
import type { ProviderHealthTracker } from "../health/ProviderHealthTracker.js";
import { downgradeRequestForAttempt, missingForModel, supportsMediaRequirements } from "../media/modelMediaSupport.js";
import type { RouterDecision, RouterExecuteContext } from "../protocol/decision.js";
import type { RouterEventBus } from "../protocol/events.js";
import { stripSubagentTagFromMessages } from "../scenario/subagentDetector.js";
import type { SessionUsageCache } from "../session/sessionUsageCache.js";
import type { TokenStatsCollector } from "../stats/TokenStatsCollector.js";
import { countMessagesTokens, countResponseTokens } from "../utils/countTokens.js";
import { collectRequiredInputModalities } from "../utils/mediaRequirements.js";
import { shouldTransientRetry, shouldZeroUsageRetry } from "../retry/retryGates.js";
import {
  type AttemptOutcome,
  abortableDelay,
  classifyRetryReason,
  protocolForProvider,
  streamAttempt,
} from "./streamAttempt.js";

const satiLogger = createLogger("sati");

/** `executeRouterDecision` 的显式依赖：原闭包捕获量在此收敛为一个对象。 */
export type RouterExecutionDeps = {
  enabled: boolean;
  config: RouterConfig;
  stats: TokenStatsCollector;
  usageCache: SessionUsageCache;
  events: RouterEventBus;
  telemetry?: TelemetryClient;
  /** 会话级健康度表的取用口；`shutdown()` 清表语义因此留在 runtime 侧。 */
  healthTrackerFor: (sessionId: string) => ProviderHealthTracker;
  /** 与 `RouterRuntimeDeps.now` 同形：缺省即 `new Date()`。 */
  now?: () => Date;
  modelRuntime: ModelRuntime;
};

/**
 * 执行一次路由决策：候选分档 → 逐 attempt 流式执行 → fallback / transient-retry /
 * zero-usage 三套重试 → 用量与统计落账。
 *
 * 从 `createRouterRuntime` 的巨型闭包抽出（债务 #343 / TD-ROUTER-001 + 002）。
 * 抽出前它是 411 行的嵌套异步生成器，而全量套件里的 router 一律 `enabled: false`
 * 直通，因此 fallback / 三种重试 / 「已产出内容是否可重放」的状态机**此前零直接
 * 覆盖**；现在它是模块级函数，`tests/router/router-runtime-execute.spec.ts` 逐条钉死。
 *
 * 关键不变量：一旦向消费方吐出过内容事件（text/thinking/tool），就**不再** fallback
 * 或重试——否则会向用户泄漏重复文本（见 `isContentEvent` 的长注释）。
 */

type AttemptPlan = {
  attempt: RouterModelRef;
  downgradeUnsupportedMedia: boolean;
};

export function applyDecisionToRequest(
  decision: RouterDecision,
  request: CanonicalModelRequest,
  deps: Pick<RouterExecutionDeps, "modelRuntime">,
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
    deps.modelRuntime,
  );
}

/**
 * "Content" events are the ones that are visible to the end-user / agent
 * loop in a way that can't be retracted: text, thinking, and tool-call
 * material. Once we've yielded any of these to the consumer, fallback /
 * retry would produce duplicates, so we lock in the current attempt.
 */
function isContentEvent(event: CanonicalModelEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "tool_call_start" ||
    event.type === "tool_call_delta" ||
    event.type === "tool_call_end"
  );
}

function clampMaxOutputTokensToModelCap(
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

function createUnsupportedMediaError(
  attempt: RouterModelRef,
  required: readonly InputModality[],
  missing: readonly InputModality[],
  protocol: ModelProtocol,
): import("../../model/index.js").CanonicalModelError {
  const missingText = (missing.length > 0 ? missing : required).join(", ");
  const requiredText = required.join(", ");
  return {
    provider: attempt.provider,
    protocol,
    code: "unsupported_modality",
    message:
      `Router could not find a configured fallback model for ${attempt.provider}/${attempt.model} ` +
      `that supports required input modalities: ${requiredText}. Missing: ${missingText}.`,
    retryable: false,
  };
}

export async function* executeRouterDecision(
  decision: RouterDecision,
  request: CanonicalModelRequest,
  ctx: RouterExecuteContext,
  deps: RouterExecutionDeps,
): AsyncIterable<CanonicalModelEvent> {
  // 闭包原有的别名变量在此显式取出；以下函数体与原实现逐字节一致。
  const { enabled, config, stats, usageCache, events, telemetry, healthTrackerFor: getHealthTracker } = deps;
  if (!enabled) {
    const passthroughRequest: CanonicalModelRequest = {
      ...request,
      provider: decision.provider,
      model: decision.model,
    };
    const downgradedPassthrough = downgradeRequestForAttempt(
      passthroughRequest,
      { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model },
      deps.modelRuntime,
    );
    const cappedPassthroughRequest = clampMaxOutputTokensToModelCap(downgradedPassthrough, deps.modelRuntime);
    let sawErrorEvent = false;
    for await (const item of streamAttempt(cappedPassthroughRequest, deps.modelRuntime, ctx, events)) {
      if (item.kind === "event") {
        if (item.event.type === "error") {
          sawErrorEvent = true;
        }
        yield item.event;
        continue;
      }
      if (item.outcome.error && !sawErrorEvent) {
        yield { type: "error", error: item.outcome.error };
      }
    }
    return;
  }

  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const fallbackPlan = planFallback(config.fallback, decision.scenarioType);
  const baseRequest = applyDecisionToRequest(decision, request, deps);
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
    supportsMediaRequirements(attempt, requiredModalities, deps.modelRuntime),
  );
  const downgradedAttempts: RouterModelRef[] =
    requiredModalities.length > 0
      ? candidateAttempts.filter(attempt => !supportsMediaRequirements(attempt, requiredModalities, deps.modelRuntime))
      : [];
  const attemptPlans: AttemptPlan[] = [
    ...nativeAttempts.map(attempt => ({ attempt, downgradeUnsupportedMedia: false })),
    ...downgradedAttempts.map(attempt => ({ attempt, downgradeUnsupportedMedia: true })),
  ];
  const zeroUsageMax = Math.max(1, config.zeroUsageRetry?.maxAttempts ?? 5);
  const zeroUsageEnabled = config.zeroUsageRetry?.enabled ?? true;
  const transientRetryEnabled = config.transientRetry?.enabled ?? true;
  const transientRetryMax = Math.max(1, config.transientRetry?.maxAttempts ?? LITELLM_DEFAULT_MAX_RETRIES);
  const transientBaseDelayMs = config.transientRetry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS;
  const transientMaxDelayMs = config.transientRetry?.maxDelayMs ?? LITELLM_MAX_RETRY_DELAY_MS;

  let lastBuffered: CanonicalModelEvent[] = [];
  let lastError: import("../../model/index.js").CanonicalModelError | undefined;
  let lastUsage: import("../../model/index.js").CanonicalUsage | undefined;
  let lastAttempt: RouterModelRef | undefined;
  let lastDecision: RouterDecision = decision;
  let lastHasYieldedContent = false;

  if (attemptPlans.length === 0) {
    const missing = missingForModel(requestedAttempt, requiredModalities, deps.modelRuntime);
    const error = createUnsupportedMediaError(
      requestedAttempt,
      requiredModalities,
      missing,
      protocolForProvider(deps.modelRuntime, requestedAttempt.provider),
    );
    events.emit({
      type: "sati_router_execute_failed",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      scenarioType: decision.scenarioType,
      provider: requestedAttempt.provider,
      model: requestedAttempt.model,
      error,
    });
    yield { type: "error", error };
    return;
  }

  outer: for (let attemptIndex = 0; attemptIndex < attemptPlans.length; attemptIndex += 1) {
    if (ctx.abortSignal?.aborted) {
      return;
    }
    const attemptPlan = attemptPlans[attemptIndex];
    const attempt = attemptPlan.attempt;
    if (
      attemptIndex > 0 &&
      getHealthTracker(ctx.sessionId).shouldSkip(attempt.provider) &&
      attemptIndex < attemptPlans.length - 1
    ) {
      continue;
    }
    const attemptDecision: RouterDecision = {
      ...decision,
      provider: attempt.provider,
      model: attempt.model,
      resolvedFrom: attemptIndex === 0 ? decision.resolvedFrom : "fallback",
    };
    let attemptRequest = applyDecisionToRequest(attemptDecision, request, deps);
    if (attemptPlan.downgradeUnsupportedMedia) {
      attemptRequest = downgradeRequestForAttempt(attemptRequest, attempt, deps.modelRuntime);
    }
    lastAttempt = attempt;
    lastDecision = attemptDecision;

    if (decision.isSubagent && config.autoOrchestrate?.subagentMaxTokens) {
      const budget = config.autoOrchestrate.subagentMaxTokens;
      const estimated = countMessagesTokens(attemptRequest.messages);
      if (estimated > budget) {
        yield {
          type: "error",
          error: {
            provider: attempt.provider,
            protocol: protocolForProvider(deps.modelRuntime, attempt.provider),
            code: "subagent_budget_exceeded",
            message: `Sub-agent budget exceeded (${estimated} estimated tokens > ${budget} limit).`,
            retryable: false,
            userHint:
              "Reduce the subagent prompt/context, increase the subagent token budget, or split the task into smaller steps.",
          },
        } as CanonicalModelEvent;
        return;
      }
    }

    let zeroUsageAttempt = 0;
    let transientRetryCount = 0;
    while (true) {
      zeroUsageAttempt += 1;
      // Live-stream events. We track whether we've already surfaced any
      // content event (text/thinking/tool) to the consumer; once we have,
      // fallback / retry is no longer safe (would duplicate text).
      let hasYieldedContent = false;
      const pending: CanonicalModelEvent[] = [];
      let outcome: AttemptOutcome | undefined;

      for await (const item of streamAttempt(attemptRequest, deps.modelRuntime, ctx, events)) {
        if (item.kind === "outcome") {
          outcome = item.outcome;
          break;
        }
        const event = item.event;
        if (!hasYieldedContent && isContentEvent(event)) {
          // Flush any framing events queued before the first content delta
          // (request_started / message_start) and the content event itself.
          for (const queued of pending) {
            yield queued;
          }
          pending.length = 0;
          yield event;
          hasYieldedContent = true;
          continue;
        }
        if (hasYieldedContent) {
          yield event;
          continue;
        }
        // Pre-content phase: defer framing events; we may need to swallow
        // them and replay from a fallback attempt.
        pending.push(event);
      }

      if (!outcome) {
        lastHasYieldedContent = hasYieldedContent;
        break outer;
      }

      lastBuffered = outcome.buffered;
      lastUsage = outcome.usage;

      if (outcome.error) {
        lastError = outcome.error;
        getHealthTracker(ctx.sessionId).recordFailure(attempt.provider);
        if (!hasYieldedContent && isFallbackEligible(outcome.error)) {
          if (attemptIndex < attemptPlans.length - 1) {
            const next = attemptPlans[attemptIndex + 1].attempt;
            events.emit({
              type: "sati_router_fallback",
              sessionId: ctx.sessionId,
              turnId: ctx.turnId,
              scenarioType: attemptDecision.scenarioType,
              attempt: attemptIndex + 1,
              fromProvider: attempt.provider,
              fromModel: attempt.model,
              toProvider: next.provider,
              toModel: next.model,
              error: outcome.error,
            });
            telemetry?.trackFeatureLoopStage({
              module: "router",
              ownerModule: "router",
              phase: "fallback",
              loopStage: "module_event",
              outcome: "success",
              sessionId: ctx.sessionId,
              metadata: {
                event: "fallback_attempt",
                scenarioType: attemptDecision.scenarioType,
                attempt: attemptIndex + 1,
                fromProvider: attempt.provider,
                fromModel: attempt.model,
                toProvider: next.provider,
                toModel: next.model,
                errorCode: outcome.error.code,
              },
            });
            continue outer;
          }
        }
        if (
          shouldTransientRetry({
            hasYieldedContent,
            fallbackEligible: isFallbackEligible(outcome.error),
            enabled: transientRetryEnabled,
            retryCount: transientRetryCount,
            maxRetries: transientRetryMax,
          })
        ) {
          const delay = computeBackoffDelay(
            transientRetryCount,
            {
              baseMs: transientBaseDelayMs,
              capMs: transientMaxDelayMs,
              growth: "linear",
              jitterRatio: LITELLM_RETRY_JITTER,
            },
            outcome.error.retryAfterMs ?? undefined,
          );
          satiLogger.warn(
            `transientRetry: ${outcome.error.code} (attempt ${transientRetryCount + 1}/${transientRetryMax}, delay=${Math.round(delay)}ms)`,
          );
          events.emit({
            type: "sati_router_transient_retry",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: transientRetryCount + 1,
            delayMs: Math.round(delay),
            provider: attempt.provider,
            model: attempt.model,
            errorCode: outcome.error.code,
          });
          events.emit({
            type: "sati_router_retry_progress",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: transientRetryCount + 1,
            maxAttempts: transientRetryMax,
            delayMs: Math.round(delay),
            reason: classifyRetryReason(outcome.error.code),
            provider: attempt.provider,
            model: attempt.model,
          });
          telemetry?.trackFeatureLoopStage({
            module: "router",
            ownerModule: "router",
            phase: "fallback",
            loopStage: "module_event",
            outcome: "success",
            sessionId: ctx.sessionId,
            metadata: {
              event: "transient_retry",
              attempt: transientRetryCount + 1,
              delayMs: Math.round(delay),
              provider: attempt.provider,
              model: attempt.model,
              errorCode: outcome.error.code,
            },
          });
          await abortableDelay(delay, ctx.abortSignal);
          transientRetryCount++;
          continue;
        }
        // mid-stream continuation 已移除：流中段失败（rate_limit/overloaded）
        // 统一由 streamModel 的 streamInterruption 机制（#511）接管——部分
        // 内容由 AgentLoop 恢复链续接，router 不再手工拼接 continuation
        // request（避免与 checkpoint 累积的双重续接）。
        for (const queued of pending) {
          yield queued;
        }
        lastHasYieldedContent = hasYieldedContent;
        break outer;
      }

      if (
        shouldZeroUsageRetry({
          hasYieldedContent,

          enabled: zeroUsageEnabled,

          attemptSaysRetry: outcome.shouldRetryZeroUsage,

          attempt: zeroUsageAttempt,

          maxAttempts: zeroUsageMax,
        })
      ) {
        satiLogger.warn(
          `zeroUsageRetry: empty response from ${attempt.provider}/${attempt.model} ` +
            `(attempt ${zeroUsageAttempt}/${zeroUsageMax}, session=${ctx.sessionId})`,
        );
        events.emit({
          type: "sati_router_zero_usage_retry",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          attempt: zeroUsageAttempt,
          provider: attempt.provider,
          model: attempt.model,
        });
        events.emit({
          type: "sati_router_retry_progress",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          attempt: zeroUsageAttempt,
          maxAttempts: zeroUsageMax,
          delayMs: 500 * zeroUsageAttempt,
          reason: "zero_usage",
          provider: attempt.provider,
          model: attempt.model,
        });
        telemetry?.trackFeatureLoopStage({
          module: "router",
          ownerModule: "router",
          phase: "fallback",
          loopStage: "module_event",
          outcome: "success",
          sessionId: ctx.sessionId,
          metadata: {
            event: "zero_usage_retry",
            attempt: zeroUsageAttempt,
            provider: attempt.provider,
            model: attempt.model,
          },
        });
        await abortableDelay(500 * zeroUsageAttempt, ctx.abortSignal);
        continue;
      }

      getHealthTracker(ctx.sessionId).recordSuccess(attempt.provider);

      if (!hasYieldedContent) {
        for (const queued of pending) {
          yield queued;
        }
      }

      const endedAt = (deps.now?.() ?? new Date()).toISOString();
      let finalUsage = outcome.usage;
      if (!finalUsage || (!finalUsage.inputTokens && !finalUsage.outputTokens)) {
        const inputEst = countMessagesTokens(attemptRequest.messages);
        const outputEst = countResponseTokens(outcome.buffered);
        finalUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
      }
      usageCache.observe(ctx.sessionId, finalUsage);
      stats.observe({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        projectPath: ctx.projectPath,
        scenarioType: attemptDecision.scenarioType,
        resolvedFrom: attemptDecision.resolvedFrom,
        provider: attempt.provider,
        model: attempt.model,
        tier: decision.tokenSaverTier,
        role: decision.isSubagent ? "subagent" : "main",
        usage: finalUsage,
        startedAt,
        endedAt,
      });
      return;
    }
  }

  if (lastError && lastAttempt) {
    events.emit({
      type: "sati_router_execute_failed",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      scenarioType: lastDecision.scenarioType,
      provider: lastAttempt.provider,
      model: lastAttempt.model,
      error: lastError,
    });
    const endedAt = (deps.now?.() ?? new Date()).toISOString();
    let failUsage = lastUsage;
    if (!failUsage || (!failUsage.inputTokens && !failUsage.outputTokens)) {
      const inputEst = countMessagesTokens(request.messages);
      const outputEst = countResponseTokens(lastBuffered);
      failUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
    }
    stats.observe({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      projectPath: ctx.projectPath,
      scenarioType: lastDecision.scenarioType,
      resolvedFrom: lastDecision.resolvedFrom,
      provider: lastAttempt.provider,
      model: lastAttempt.model,
      tier: decision.tokenSaverTier,
      role: decision.isSubagent ? "subagent" : "main",
      usage: failUsage,
      startedAt,
      endedAt,
    });
    if (!lastHasYieldedContent) {
      for (const event of lastBuffered) {
        if (event.type !== "error") {
          yield event;
        }
      }
    }
    yield { type: "error", error: { ...lastError, provider: lastAttempt.provider, model: lastAttempt.model } };
  }
}
