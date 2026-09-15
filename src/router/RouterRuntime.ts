import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../model/index.js";
import type { TelemetryClient } from "../telemetry/index.js";
import type { RouterConfig } from "./config/schema.js";
import type { CustomRouterRegistry } from "./customRouter/customRouter.js";
import { noopCustomRouterRegistry } from "./customRouter/customRouter.js";
import { decideRouterDecision, type RouterDecisionDeps } from "./decision/decideRouterDecision.js";
import {
  applyDecisionToRequest,
  executeRouterDecision,
  type RouterExecutionDeps,
} from "./execution/executeRouterDecision.js";
import { ProviderHealthTracker } from "./health/ProviderHealthTracker.js";
import type { RouterDecision, RouterDecisionInput, RouterExecuteContext } from "./protocol/decision.js";
import type { RouterEventBus } from "./protocol/events.js";
import { SessionRouterStore } from "./session/SessionRouterStore.js";
import { SessionUsageCache } from "./session/sessionUsageCache.js";
import { TokenStatsCollector } from "./stats/TokenStatsCollector.js";
import { dispose as disposeTokenizer } from "./utils/countTokens.js";

export type RouterRuntimeDeps = {
  modelRuntime: ModelRuntime;
  judgeRuntime?: ModelRuntime;
  customRouterRegistry?: CustomRouterRegistry;
  /** Optional skill prompt loader for AutoOrchestrate; receives extension id, returns text. */
  loadSkillPrompt?: (extensionId: string) => Promise<string | undefined>;
  events?: RouterEventBus;
  telemetry?: TelemetryClient;
  now?: () => Date;
  /**
   * Externally-owned session store that survives config-reload cycles.
   * When provided, `shutdown()` will NOT clear it.
   */
  sessionStore?: SessionRouterStore;
};

export type InvalidateStickyResult = {
  previousTier?: string;
  previousProvider?: string;
  previousModel?: string;
  orchestrating: boolean;
};

export type RouterRuntime = {
  decide(input: RouterDecisionInput): Promise<RouterDecision>;
  execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent>;
  /** Convenience helper used by agent loop: decide + execute in one call. */
  stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean; previousTier?: string },
  ): AsyncIterable<CanonicalModelEvent>;
  materializeRequest(decision: RouterDecision, request: CanonicalModelRequest): CanonicalModelRequest;
  /**
   * Clear routing sticky (provider/model/tier) for a session while preserving
   * orchestration state.  Call at the start of each new user turn so the
   * judge re-classifies the fresh message instead of reusing a stale tier.
   */
  invalidateSticky(sessionId: string): InvalidateStickyResult;
  observeUsage(sessionId: string, usage: import("../model/index.js").CanonicalUsage | undefined): void;
  stats: TokenStatsCollector;
  shutdown(): Promise<void>;
};

/**
 * 路由运行时装配层。
 *
 * 债务 #343（TD-ROUTER-001 + 002 + 003）：本文件曾是 1230 行的「一个巨型闭包承载
 * config 归一 / session store / health cache / 决策 / 执行 / 重试 / 编排 / 统计八件事」，
 * `decide()` 与 `execute()` 都是捕获外层十来个变量的嵌套函数，因而无法脱离 runtime
 * 实例单测。现在职责已按模块拆开，本文件只保留**装配**：
 *
 * - `decision/decideRouterDecision.ts` —— 决策（选 model / 场景 / 编排门控 / 落粘性）
 * - `execution/executeRouterDecision.ts` —— 执行与三套重试编排
 * - `execution/streamAttempt.ts` —— 单 attempt 执行器 + 流错误归类
 * - `sticky/preserveStickyForCache.ts` —— cache-aware 切换判定（纯函数）
 * - `media/*` —— 媒体能力查询与重路由（`utils/mediaReroute.ts` 早先已抽出纯函数部分）
 *
 * 闭包捕获量收敛为 `RouterDecisionDeps` / `RouterExecutionDeps` 两个显式对象；这里
 * 仍由闭包持有的是**有生命周期的状态**：stats / sessionStore / usageCache /
 * healthTrackers（`shutdown()` 要清它们）。
 */
export function createRouterRuntime(config: RouterConfig, deps: RouterRuntimeDeps): RouterRuntime {
  const enabled = config.enabled !== false;
  const stats = new TokenStatsCollector({
    ...config.stats,
    enabled: enabled && (config.stats?.enabled ?? false),
    baselineModel: config.scenarios?.default
      ? { provider: config.scenarios.default.provider, model: config.scenarios.default.model }
      : config.stats?.baselineModel,
  });
  const externalStore = !!deps.sessionStore;
  const sessionStore =
    deps.sessionStore ??
    new SessionRouterStore({
      now: () => (deps.now?.() ?? new Date()).getTime(),
    });
  const usageCache = new SessionUsageCache();
  const customRouters = deps.customRouterRegistry ?? noopCustomRouterRegistry;
  const judgeRuntime = deps.judgeRuntime ?? deps.modelRuntime;
  const events = deps.events ?? { emit: () => undefined };
  const telemetry = deps.telemetry;
  const healthTrackers = new Map<string, ProviderHealthTracker>();
  function getHealthTracker(sessionId: string): ProviderHealthTracker {
    let tracker = healthTrackers.get(sessionId);
    if (!tracker) {
      tracker = new ProviderHealthTracker();
      healthTrackers.set(sessionId, tracker);
    }
    return tracker;
  }

  const decisionDeps: RouterDecisionDeps = {
    enabled,
    config,
    sessionStore,
    usageCache,
    judgeRuntime,
    events,
    telemetry,
    customRouters,
    now: deps.now,
    modelRuntime: deps.modelRuntime,
  };
  const executionDeps: RouterExecutionDeps = {
    enabled,
    config,
    stats,
    usageCache,
    events,
    telemetry,
    healthTrackerFor: getHealthTracker,
    now: deps.now,
    modelRuntime: deps.modelRuntime,
  };

  const decide = (input: RouterDecisionInput): Promise<RouterDecision> => decideRouterDecision(input, decisionDeps);
  const execute = (
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent> => executeRouterDecision(decision, request, ctx, executionDeps);
  const materializeRequest = (decision: RouterDecision, request: CanonicalModelRequest): CanonicalModelRequest =>
    applyDecisionToRequest(decision, request, executionDeps);

  async function* stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean; previousTier?: string },
  ): AsyncIterable<CanonicalModelEvent> {
    const decision = await decide({
      request,
      sessionId: ctx.sessionId,
      isMainAgent: ctx.isMainAgent,
      abortSignal: ctx.abortSignal,
      metadata: ctx.previousTier ? { previousTier: ctx.previousTier } : undefined,
    });
    yield* execute(decision, request, ctx);
  }

  function invalidateSticky(sessionId: string): InvalidateStickyResult {
    if (!enabled) {
      return { orchestrating: false };
    }

    const current = sessionStore.get(sessionId, false);
    const previousTier = current?.tokenSaverTier;
    const previousProvider = current?.stickyProvider;
    const previousModel = current?.stickyModel;
    const orchestrating = current?.orchestrating ?? false;
    if (orchestrating && previousTier) {
      // While orchestrating, preserve the tier sticky so continuation turns
      // don't get re-judged and accidentally downgraded.
      sessionStore.set({
        sessionId,
        isSubagent: false,
        orchestrating,
        tokenSaverTier: previousTier,
        stickyProvider: current?.stickyProvider,
        stickyModel: current?.stickyModel,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    } else {
      sessionStore.set({
        sessionId,
        isSubagent: false,
        orchestrating,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    }
    return { previousTier, previousProvider, previousModel, orchestrating };
  }

  return {
    decide,
    execute,
    stream,
    materializeRequest,
    invalidateSticky,
    observeUsage(sessionId, usage) {
      if (!enabled) return;
      usageCache.observe(sessionId, usage);
    },
    stats,
    async shutdown() {
      await stats.flush();
      stats.dispose();
      disposeTokenizer();
      if (!externalStore) sessionStore.clear();
      usageCache.clear();
      healthTrackers.clear();
    },
  };
}
