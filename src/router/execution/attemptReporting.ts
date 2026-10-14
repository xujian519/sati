import type { CanonicalModelEvent, CanonicalModelError, CanonicalModelRequest } from "../../model/index.js";
import { createLogger } from "../../telemetry/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { RouterModelRef } from "../config/schema.js";
import type { RouterDecision, RouterExecuteContext } from "../protocol/decision.js";
import type { RouterEventBus } from "../protocol/events.js";
import type { SessionUsageCache } from "../session/sessionUsageCache.js";
import type { TokenStatsCollector } from "../stats/TokenStatsCollector.js";
import { countMessagesTokens, countResponseTokens } from "../utils/countTokens.js";
import { abortableDelay, classifyRetryReason } from "./streamAttempt.js";

/**
 * 执行期的**上报与落账**：#646 sweep P2.6 把 `executeRouterDecision` 里三处重试/回退的
 * 上报块与成功/失败的用量落账搬到这里。
 *
 * 与 `attemptPlanning.ts` 的分工：那边只判定「下一步做什么」，这边负责把已定的动作
 * 施行出去（emit / 打点 / 日志 / 退避 sleep / stats·usageCache 落账）。
 *
 * ⚠️ `events.emit({ … })` 的对象字面量必须留在**本文件的调用点**：`gen-event-matrix`
 * 的生产者启发式只认「调用/`yield` 的首参是对象字面量」（`scripts/gen-event-matrix.ts:180`），
 * 若改成先构造变量再传参，本文件会从事件矩阵的生产者面消失。
 */

const satiLogger = createLogger("sati");

/** fallback：换下一个候选前上报一次（原执行体内的 fallback 块逐字搬入）。 */
export function reportFallbackTransition(args: {
  ctx: RouterExecuteContext;
  events: RouterEventBus;
  telemetry?: TelemetryClient;
  attemptIndex: number;
  attemptDecision: RouterDecision;
  attempt: RouterModelRef;
  next: RouterModelRef;
  error: CanonicalModelError;
}): void {
  const { ctx, events } = args;
  events.emit({
    type: "sati_router_fallback",
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    scenarioType: args.attemptDecision.scenarioType,
    attempt: args.attemptIndex + 1,
    fromProvider: args.attempt.provider,
    fromModel: args.attempt.model,
    toProvider: args.next.provider,
    toModel: args.next.model,
    error: args.error,
  });
  args.telemetry?.trackFeatureLoopStage({
    module: "router",
    ownerModule: "router",
    phase: "fallback",
    loopStage: "module_event",
    outcome: "success",
    sessionId: ctx.sessionId,
    metadata: {
      event: "fallback_attempt",
      scenarioType: args.attemptDecision.scenarioType,
      attempt: args.attemptIndex + 1,
      fromProvider: args.attempt.provider,
      fromModel: args.attempt.model,
      toProvider: args.next.provider,
      toModel: args.next.model,
      errorCode: args.error.code,
    },
  });
}

/** 传输层重试：日志 + 两个事件 + 打点 + 退避等待（同一 attempt 内重发）。 */
export async function reportTransientRetry(args: {
  ctx: RouterExecuteContext;
  events: RouterEventBus;
  telemetry?: TelemetryClient;
  attempt: RouterModelRef;
  retryCount: number;
  maxRetries: number;
  delayMs: number;
  error: CanonicalModelError;
}): Promise<void> {
  const { ctx, events, attempt } = args;
  satiLogger.warn(
    `transientRetry: ${args.error.code} (attempt ${args.retryCount + 1}/${args.maxRetries}, delay=${Math.round(args.delayMs)}ms)`,
  );
  events.emit({
    type: "sati_router_transient_retry",
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    attempt: args.retryCount + 1,
    delayMs: Math.round(args.delayMs),
    provider: attempt.provider,
    model: attempt.model,
    errorCode: args.error.code,
  });
  events.emit({
    type: "sati_router_retry_progress",
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    attempt: args.retryCount + 1,
    maxAttempts: args.maxRetries,
    delayMs: Math.round(args.delayMs),
    reason: classifyRetryReason(args.error.code),
    provider: attempt.provider,
    model: attempt.model,
  });
  args.telemetry?.trackFeatureLoopStage({
    module: "router",
    ownerModule: "router",
    phase: "fallback",
    loopStage: "module_event",
    outcome: "success",
    sessionId: ctx.sessionId,
    metadata: {
      event: "transient_retry",
      attempt: args.retryCount + 1,
      delayMs: Math.round(args.delayMs),
      provider: attempt.provider,
      model: attempt.model,
      errorCode: args.error.code,
    },
  });
  await abortableDelay(args.delayMs, ctx.abortSignal);
}

/** 空回合（无内容、零用量）重试：日志 + 两个事件 + 打点 + 退避等待。 */
export async function reportZeroUsageRetry(args: {
  ctx: RouterExecuteContext;
  events: RouterEventBus;
  telemetry?: TelemetryClient;
  attempt: RouterModelRef;
  zeroUsageAttempt: number;
  maxAttempts: number;
  delayMs: number;
}): Promise<void> {
  const { ctx, events, attempt } = args;
  satiLogger.warn(
    `zeroUsageRetry: empty response from ${attempt.provider}/${attempt.model} ` +
      `(attempt ${args.zeroUsageAttempt}/${args.maxAttempts}, session=${ctx.sessionId})`,
  );
  events.emit({
    type: "sati_router_zero_usage_retry",
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    attempt: args.zeroUsageAttempt,
    provider: attempt.provider,
    model: attempt.model,
  });
  events.emit({
    type: "sati_router_retry_progress",
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    attempt: args.zeroUsageAttempt,
    maxAttempts: args.maxAttempts,
    delayMs: args.delayMs,
    reason: "zero_usage",
    provider: attempt.provider,
    model: attempt.model,
  });
  args.telemetry?.trackFeatureLoopStage({
    module: "router",
    ownerModule: "router",
    phase: "fallback",
    loopStage: "module_event",
    outcome: "success",
    sessionId: ctx.sessionId,
    metadata: {
      event: "zero_usage_retry",
      attempt: args.zeroUsageAttempt,
      provider: attempt.provider,
      model: attempt.model,
    },
  });
  await abortableDelay(args.delayMs, ctx.abortSignal);
}

/** 成功落账：用量进会话缓存、统计收口（缺失用量由 token 估算补齐）。 */
export function finalizeAttemptSuccess(args: {
  ctx: RouterExecuteContext;
  stats: TokenStatsCollector;
  usageCache: SessionUsageCache;
  decision: RouterDecision;
  attemptDecision: RouterDecision;
  attempt: RouterModelRef;
  attemptRequest: CanonicalModelRequest;
  buffered: CanonicalModelEvent[];
  usage: import("../../model/index.js").CanonicalUsage | undefined;
  startedAt: string;
  endedAt: string;
}): void {
  const { ctx, attempt } = args;
  let finalUsage = args.usage;
  if (!finalUsage || (!finalUsage.inputTokens && !finalUsage.outputTokens)) {
    const inputEst = countMessagesTokens(args.attemptRequest.messages);
    const outputEst = countResponseTokens(args.buffered);
    finalUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
  }
  args.usageCache.observe(ctx.sessionId, finalUsage);
  args.stats.observe({
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    projectPath: ctx.projectPath,
    scenarioType: args.attemptDecision.scenarioType,
    resolvedFrom: args.attemptDecision.resolvedFrom,
    provider: attempt.provider,
    model: attempt.model,
    tier: args.decision.tokenSaverTier,
    role: args.decision.isSubagent ? "subagent" : "main",
    usage: finalUsage,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
  });
}

/** 终态失败落账：用量补齐后落一条统计（回放与终态错误由编排体负责 yield）。 */
export function finalizeAttemptFailure(args: {
  ctx: RouterExecuteContext;
  stats: TokenStatsCollector;
  decision: RouterDecision;
  lastDecision: RouterDecision;
  attempt: RouterModelRef;
  request: CanonicalModelRequest;
  buffered: CanonicalModelEvent[];
  usage: import("../../model/index.js").CanonicalUsage | undefined;
  startedAt: string;
  endedAt: string;
}): void {
  const { ctx, attempt } = args;
  let failUsage = args.usage;
  if (!failUsage || (!failUsage.inputTokens && !failUsage.outputTokens)) {
    const inputEst = countMessagesTokens(args.request.messages);
    const outputEst = countResponseTokens(args.buffered);
    failUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
  }
  args.stats.observe({
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    projectPath: ctx.projectPath,
    scenarioType: args.lastDecision.scenarioType,
    resolvedFrom: args.lastDecision.resolvedFrom,
    provider: attempt.provider,
    model: attempt.model,
    tier: args.decision.tokenSaverTier,
    role: args.decision.isSubagent ? "subagent" : "main",
    usage: failUsage,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
  });
}
