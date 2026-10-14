import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  InputModality,
  ModelProtocol,
  ModelRuntime,
} from "../../model/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { RouterConfig, RouterModelRef } from "../config/schema.js";
import type { ProviderHealthTracker } from "../health/ProviderHealthTracker.js";
import { downgradeRequestForAttempt, missingForModel } from "../media/modelMediaSupport.js";
import type { RouterDecision, RouterExecuteContext, RouterTransformTag } from "../protocol/decision.js";
import type { RouterEventBus } from "../protocol/events.js";
import type { SessionUsageCache } from "../session/sessionUsageCache.js";
import type { TokenStatsCollector } from "../stats/TokenStatsCollector.js";
import {
  clampMaxOutputTokensToModelCap,
  classifyAttemptGate,
  planAttempt,
  planAttemptExecution,
  subagentBudgetError,
} from "./attemptPlanning.js";
import {
  finalizeAttemptFailure,
  finalizeAttemptSuccess,
  reportFallbackTransition,
  reportTransientRetry,
  reportZeroUsageRetry,
} from "./attemptReporting.js";
import { type AttemptOutcome, protocolForProvider, streamAttempt } from "./streamAttempt.js";

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
 * #646 sweep P2.6 起本文件只留**编排**：判定在 `attemptPlanning.ts`（纯函数）、
 * 上报与落账在 `attemptReporting.ts`，全部 `yield` 仍留在本文件——事件矩阵的
 * 生产者面因此只在行号上位移，不跨文件。
 *
 * 关键不变量：一旦向消费方吐出过内容事件（text/thinking/tool），就**不再** fallback
 * 或重试——否则会向用户泄漏重复文本（见 `isContentEvent` 的长注释）。
 */

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

/**
 * 本次派发**实际施行**了哪些请求改写。
 *
 * 取值来自执行期事实（哪些改写分支跑了、夹取有没有改变上限），**不**来自
 * 「比对快照算出的差异」——对拍的另一侧（调用方持有的落盘快照）由另一份入参
 * 派生，两处独立，故「差异 ⊆ 声明字段」这条判据能被「注入一个未声明的改写」
 * 证伪（见 `tests/router/request-dispatch-report.spec.ts` 的负控制）。
 *
 * 只声明**它可能改掉哪些快照字段**的标签；未登记在此的标签会被对拍侧视为
 * 声明失效（映射表在 `src/agent/loop/requestInvariant.ts`）。
 */
function appliedTransformTags(args: {
  isFallbackAttempt: boolean;
  downgradeUnsupportedMedia: boolean;
  subagentTagStripped: boolean;
  requestPatch: RouterDecision["requestPatch"];
  maxOutputTokensChanged: boolean;
}): RouterTransformTag[] {
  const tags: RouterTransformTag[] = [];
  if (args.isFallbackAttempt) {
    tags.push("fallbackAttempt");
  }
  if (args.downgradeUnsupportedMedia) {
    tags.push("mediaDowngraded");
  }
  if (args.subagentTagStripped) {
    tags.push("subagentTagStripped");
  }
  if (args.maxOutputTokensChanged) {
    tags.push("maxOutputTokensClamped");
  }
  if (args.requestPatch?.messages !== undefined) {
    tags.push("requestPatch:messages");
  }
  if (args.requestPatch?.tools !== undefined) {
    tags.push("requestPatch:tools");
  }
  if (args.requestPatch?.systemPrompt !== undefined) {
    tags.push("requestPatch:systemPrompt");
  }
  return tags;
}

/**
 * 派发点：报告实况后立即转交 `streamAttempt`（`yield*` 委托，内层 `return` 成为外层 `return`）。
 *
 * 报告与流在同一条语句上，因此不存在「流了但没报」的路径——将来若出现第三条派发
 * 路径，也会被这同一处收口覆盖。`ctx.onDispatchRequest` 缺省即零开销。
 */
async function* streamAttemptWithReport(
  request: CanonicalModelRequest,
  decision: RouterDecision,
  transforms: readonly RouterTransformTag[],
  ctx: RouterExecuteContext,
  deps: RouterExecutionDeps,
  events: RouterEventBus,
): AsyncGenerator<{ kind: "event"; event: CanonicalModelEvent } | { kind: "outcome"; outcome: AttemptOutcome }> {
  ctx.onDispatchRequest?.({ request, decision, transforms });
  yield* streamAttempt(request, deps.modelRuntime, ctx, events);
}

/** 一次 attempt 的流式结果：`pending` 是首个内容事件前暂存的帧，由调用方决定回放或丢弃。 */
type BufferedAttemptResult = {
  /** 流未给出 outcome（调用方主动收尾）时为 `undefined`，与原实现的 `!outcome` 分支同义。 */
  outcome: AttemptOutcome | undefined;
  pending: CanonicalModelEvent[];
  hasYieldedContent: boolean;
};

/**
 * 带内容门控的 attempt 执行：首个内容事件之前只暂存帧事件（`request_started` /
 * `message_start` 等），一旦出现内容事件就补吐暂存帧并转入直通；若该 attempt 最终
 * 走回退或重试，暂存帧随 `pending` 交回调用方**丢弃**（否则用户会看到已作废的帧）。
 *
 * 门控本身不能内化：是否丢弃取决于调用方在拿到 outcome 后算出的 gate。
 */
async function* streamAttemptBuffered(args: {
  request: CanonicalModelRequest;
  decision: RouterDecision;
  transforms: readonly RouterTransformTag[];
  ctx: RouterExecuteContext;
  deps: RouterExecutionDeps;
  events: RouterEventBus;
}): AsyncGenerator<CanonicalModelEvent, BufferedAttemptResult> {
  let hasYieldedContent = false;
  const pending: CanonicalModelEvent[] = [];
  for await (const item of streamAttemptWithReport(
    args.request,
    args.decision,
    args.transforms,
    args.ctx,
    args.deps,
    args.events,
  )) {
    if (item.kind === "outcome") {
      return { outcome: item.outcome, pending, hasYieldedContent };
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
  return { outcome: undefined, pending, hasYieldedContent };
}

/**
 * 直通分支（`enabled: false`）的改写标签。
 *
 * 该分支**不**走 `applyDecisionToRequest`，故 `requestPatch` 与 `subagentTagStripped`
 * 在此不生效，也就不能声明为已施行（声明了会把一条真实差异错误地放行）。
 */
function passthroughTransformTags(
  original: CanonicalModelRequest,
  dispatched: CanonicalModelRequest,
): RouterTransformTag[] {
  return appliedTransformTags({
    isFallbackAttempt: false,
    // 直通路径无条件过一遍媒体降级（能力不足的块在此被替换）。
    downgradeUnsupportedMedia: true,
    subagentTagStripped: false,
    requestPatch: undefined,
    maxOutputTokensChanged: dispatched.maxOutputTokens !== original.maxOutputTokens,
  });
}

/** attempt 循环的改写标签（取自本次施行的事实）。 */
function attemptTransformTags(args: {
  attemptIndex: number;
  downgradeUnsupportedMedia: boolean;
  decision: RouterDecision;
  original: CanonicalModelRequest;
  dispatched: CanonicalModelRequest;
}): RouterTransformTag[] {
  return appliedTransformTags({
    isFallbackAttempt: args.attemptIndex > 0,
    downgradeUnsupportedMedia: args.downgradeUnsupportedMedia,
    subagentTagStripped: args.decision.mutations.subagentTagStripped === true,
    requestPatch: args.decision.requestPatch,
    maxOutputTokensChanged: args.dispatched.maxOutputTokens !== args.original.maxOutputTokens,
  });
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
    for await (const item of streamAttemptWithReport(
      cappedPassthroughRequest,
      decision,
      passthroughTransformTags(request, cappedPassthroughRequest),
      ctx,
      deps,
      events,
    )) {
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
  const { requestedAttempt, requiredModalities, attemptPlans, retry } = planAttemptExecution(
    decision,
    request,
    config,
    deps.modelRuntime,
  );

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
    const { attemptDecision, attemptRequest } = planAttempt(
      decision,
      attemptPlan,
      attemptIndex,
      request,
      deps.modelRuntime,
    );
    lastAttempt = attempt;
    lastDecision = attemptDecision;

    if (decision.isSubagent && config.autoOrchestrate?.subagentMaxTokens) {
      const budgetError = subagentBudgetError(
        decision,
        config,
        attempt,
        attemptRequest,
        protocolForProvider(deps.modelRuntime, attempt.provider),
      );
      if (budgetError) {
        yield { type: "error", error: budgetError };
        return;
      }
    }

    let zeroUsageAttempt = 0;
    let transientRetryCount = 0;
    while (true) {
      zeroUsageAttempt += 1;
      // Live-stream events with content gating: framing events are held back
      // until the first content event (see `streamAttemptBuffered`), and the
      // gate below decides whether held-back frames are replayed or dropped.
      const { outcome, pending, hasYieldedContent } = yield* streamAttemptBuffered({
        request: attemptRequest,
        decision: attemptDecision,
        transforms: attemptTransformTags({
          attemptIndex,
          downgradeUnsupportedMedia: attemptPlan.downgradeUnsupportedMedia,
          decision,
          original: request,
          dispatched: attemptRequest,
        }),
        ctx,
        deps,
        events,
      });

      if (!outcome) {
        lastHasYieldedContent = hasYieldedContent;
        break outer;
      }

      lastBuffered = outcome.buffered;
      lastUsage = outcome.usage;

      if (outcome.error) {
        lastError = outcome.error;
        getHealthTracker(ctx.sessionId).recordFailure(attempt.provider);
      }

      const gate = classifyAttemptGate({
        outcome,
        hasYieldedContent,
        attemptIndex,
        attemptCount: attemptPlans.length,
        retry,
        zeroUsageAttempt,
        transientRetryCount,
      });

      switch (gate.kind) {
        case "fallback": {
          reportFallbackTransition({
            ctx,
            events,
            telemetry,
            attemptIndex,
            attemptDecision,
            attempt,
            next: attemptPlans[attemptIndex + 1].attempt,
            error: outcome.error!,
          });
          continue outer;
        }
        case "transientRetry": {
          await reportTransientRetry({
            ctx,
            events,
            telemetry,
            attempt,
            retryCount: transientRetryCount,
            maxRetries: retry.transient.maxAttempts,
            delayMs: gate.delayMs,
            error: outcome.error!,
          });
          transientRetryCount++;
          continue;
        }
        case "zeroUsageRetry": {
          await reportZeroUsageRetry({
            ctx,
            events,
            telemetry,
            attempt,
            zeroUsageAttempt,
            maxAttempts: retry.zeroUsage.maxAttempts,
            delayMs: gate.delayMs,
          });
          continue;
        }
        case "terminalFailure": {
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
        case "success": {
          getHealthTracker(ctx.sessionId).recordSuccess(attempt.provider);

          if (!hasYieldedContent) {
            for (const queued of pending) {
              yield queued;
            }
          }

          finalizeAttemptSuccess({
            ctx,
            stats,
            usageCache,
            decision,
            attemptDecision,
            attempt,
            attemptRequest,
            buffered: outcome.buffered,
            usage: outcome.usage,
            startedAt,
            endedAt: (deps.now?.() ?? new Date()).toISOString(),
          });
          return;
        }
      }
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
    finalizeAttemptFailure({
      ctx,
      stats,
      decision,
      lastDecision,
      attempt: lastAttempt,
      request,
      buffered: lastBuffered,
      usage: lastUsage,
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
