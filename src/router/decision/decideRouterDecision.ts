import type { ModelRuntime } from "../../model/index.js";
import { createLogger } from "../../telemetry/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import { DEFAULT_SUBAGENT_POLICY, type RouterConfig, type RouterModelRef } from "../config/schema.js";
import type { CustomRouterRegistry, SatiCustomRouter } from "../customRouter/customRouter.js";
import { rerouteDecisionForMedia } from "../media/rerouteDecisionForMedia.js";
import { applyOrchestration } from "../orchestrate/applyOrchestration.js";
import type {
  RouterDecision,
  RouterDecisionInput,
  RouterMutationsLog,
  RouterScenarioType,
} from "../protocol/decision.js";
import type { RouterEventBus } from "../protocol/events.js";
import { decideScenario } from "../scenario/decideScenario.js";
import type { SessionRouterStore } from "../session/SessionRouterStore.js";
import type { SessionUsageCache } from "../session/sessionUsageCache.js";
import { preserveStickyForCache } from "../sticky/preserveStickyForCache.js";
import { classifyAndRoute } from "../tokenSaver/classifyAndRoute.js";

const routerLogger = createLogger("router");

/** `decideRouterDecision` 的显式依赖：原闭包捕获量在此收敛为一个对象。 */
export type RouterDecisionDeps = {
  enabled: boolean;
  config: RouterConfig;
  sessionStore: SessionRouterStore;
  usageCache: SessionUsageCache;
  judgeRuntime: ModelRuntime;
  events: RouterEventBus;
  telemetry?: TelemetryClient;
  customRouters: CustomRouterRegistry;
  /** 与 `RouterRuntimeDeps.now` 同形：缺省即 `new Date()`。 */
  now?: () => Date;
  modelRuntime: ModelRuntime;
};

/**
 * 路由决策：把一次请求映射成「用哪个 provider/model、走哪个场景、是否编排」。
 *
 * 从 `createRouterRuntime` 的巨型闭包抽出（债务 #343 / TD-ROUTER-001 + 003）。
 * 抽出前它是 224 行的嵌套函数，捕获外层十来个变量，因而无法脱离 runtime 实例
 * 单测——这是 router 长期缺少决策路径直接单测的直接原因。现在依赖走显式
 * `RouterDecisionDeps`，`tests/router/router-runtime-decide.spec.ts` 逐条覆盖。
 *
 * 副作用顺序（与抽出前一致）：决策完成后 `sessionStore.set` 落粘性，随后发
 * `sati_router_decision`。**不发模型请求**——执行在 `execution/executeRouterDecision.ts`。
 */

async function resolveCustom(
  input: RouterDecisionInput,
  config: RouterConfig,
  customRouters: CustomRouterRegistry,
  events: RouterEventBus,
): Promise<Partial<RouterDecision> | undefined> {
  if (!config.customRouter) {
    return undefined;
  }
  const router: SatiCustomRouter | undefined = customRouters.lookupRouter(config.customRouter.extensionId);
  if (!router) {
    return undefined;
  }
  try {
    return await router.decide({
      ...input,
      context: {
        sessionId: input.sessionId,
        isMainAgent: input.isMainAgent,
        scenarios: Object.keys(config.scenarios ?? {}),
      },
    });
  } catch (error) {
    events.emit({
      type: "sati_router_custom_failed",
      sessionId: input.sessionId,
      extensionId: config.customRouter.extensionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function decideRouterDecision(
  input: RouterDecisionInput,
  deps: RouterDecisionDeps,
): Promise<RouterDecision> {
  // 闭包原有的别名变量在此显式取出；以下函数体与原实现逐字节一致。
  const { enabled, config, sessionStore, usageCache, judgeRuntime, events, telemetry, customRouters } = deps;
  if (!enabled) {
    return {
      provider: input.request.provider,
      model: input.request.model,
      scenarioType: "default",
      isSubagent: !input.isMainAgent,
      orchestrating: false,
      resolvedFrom: "scenario",
      mutations: {},
    };
  }

  const sticky = sessionStore.get(input.sessionId, !input.isMainAgent);
  const baseUsage = usageCache.get(input.sessionId);
  const inputWithUsage: RouterDecisionInput = {
    ...input,
    metadata: {
      ...input.metadata,
      lastUsage: input.metadata?.lastUsage ?? {
        inputTokens: baseUsage?.inputTokens,
        outputTokens: baseUsage?.outputTokens,
        totalTokens: baseUsage?.totalTokens,
      },
    },
  };

  const custom = await resolveCustom(inputWithUsage, config, customRouters, events);
  const scenarioOutcome = decideScenario(inputWithUsage, config.scenarios);

  let scenarioType: RouterScenarioType = scenarioOutcome.scenarioType;
  const previousStickySelection =
    input.metadata?.previousProvider && input.metadata.previousModel
      ? {
          id: `${input.metadata.previousProvider}/${input.metadata.previousModel}`,
          provider: input.metadata.previousProvider,
          model: input.metadata.previousModel,
        }
      : sticky?.stickyProvider && sticky.stickyModel
        ? {
            id: `${sticky.stickyProvider}/${sticky.stickyModel}`,
            provider: sticky.stickyProvider,
            model: sticky.stickyModel,
          }
        : undefined;
  let selection: RouterModelRef | undefined =
    custom?.provider && custom.model
      ? { id: `${custom.provider}/${custom.model}`, provider: custom.provider, model: custom.model }
      : scenarioOutcome.selection;

  let resolvedFrom: RouterDecision["resolvedFrom"] = custom?.provider
    ? "custom"
    : scenarioType === "explicit"
      ? "explicit"
      : "scenario";

  let tokenSaverTier: string | undefined;
  let cacheAwareSwitch: RouterMutationsLog["cacheAwareSwitch"];
  const subagentPolicy = config.tokenSaver?.subagent?.policy ?? DEFAULT_SUBAGENT_POLICY;
  if (
    !custom?.provider &&
    scenarioType !== "explicit" &&
    config.tokenSaver?.enabled &&
    (input.isMainAgent || subagentPolicy !== "skip")
  ) {
    let stickyHit = false;

    if (input.isMainAgent && input.request.messages.length > 1) {
      const mainSticky = sessionStore.get(input.sessionId, false);
      if (mainSticky?.stickyProvider && mainSticky.stickyModel) {
        selection = {
          id: `${mainSticky.stickyProvider}/${mainSticky.stickyModel}`,
          provider: mainSticky.stickyProvider,
          model: mainSticky.stickyModel,
        };
        resolvedFrom = "tokenSaver";
        tokenSaverTier = mainSticky.tokenSaverTier;
        stickyHit = true;
      }
    }

    if (!input.isMainAgent && subagentPolicy === "judge" && input.request.messages.length > 1) {
      const subSticky = sessionStore.get(input.sessionId, true);
      if (subSticky?.stickyProvider && subSticky.stickyModel) {
        selection = {
          id: `${subSticky.stickyProvider}/${subSticky.stickyModel}`,
          provider: subSticky.stickyProvider,
          model: subSticky.stickyModel,
        };
        resolvedFrom = "tokenSaver";
        tokenSaverTier = subSticky.tokenSaverTier;
        stickyHit = true;
      }
    }

    if (!stickyHit) {
      const tokenSaver = await classifyAndRoute({
        config: config.tokenSaver,
        messages: input.request.messages,
        judgeRuntime,
        abortSignal: input.abortSignal,
        previousTier: input.metadata?.previousTier,
        sessionId: input.sessionId,
        telemetry,
      });
      if (tokenSaver) {
        if (tokenSaver.failureReason) {
          const failure = tokenSaver.failure;
          events.emit({
            type: "sati_router_token_saver_failed",
            sessionId: input.sessionId,
            reason: tokenSaver.failureReason,
            fallbackTier: tokenSaver.tier,
            judgeProvider: config.tokenSaver.judge.provider,
            judgeModel: config.tokenSaver.judge.model,
            attempts: failure?.attempts ?? 1,
            ...(failure?.code ? { errorCode: failure.code } : {}),
            ...(failure?.message ? { errorMessage: failure.message } : {}),
          });
        }
        if (tokenSaver.selection) {
          selection = tokenSaver.selection;
          resolvedFrom = "tokenSaver";
          const cacheAware = preserveStickyForCache(
            previousStickySelection,
            selection,
            input.request.messages,
            baseUsage,
            config,
          );
          selection = cacheAware.selection;
          cacheAwareSwitch = cacheAware.mutation;
        }
        tokenSaverTier =
          cacheAwareSwitch?.action === "kept_sticky"
            ? (sticky?.tokenSaverTier ?? input.metadata?.previousTier ?? tokenSaver.tier)
            : tokenSaver.tier;
      }
    }
  }

  if (!selection && scenarioOutcome.subagentModelHint) {
    const slash = scenarioOutcome.subagentModelHint.indexOf("/");
    if (slash >= 0) {
      const provider = scenarioOutcome.subagentModelHint.slice(0, slash);
      const model = scenarioOutcome.subagentModelHint.slice(slash + 1);
      if (provider && model) {
        selection = { id: scenarioOutcome.subagentModelHint, provider, model };
        resolvedFrom = "explicit";
      }
    }
  }

  if (!selection) {
    selection = config.scenarios?.default;
    scenarioType = scenarioType === "explicit" ? scenarioType : "default";
  }

  if (!selection) {
    throw new Error("Router: no default scenario configured and no model could be resolved");
  }

  const decision: RouterDecision = {
    provider: selection.provider,
    model: selection.model,
    scenarioType,
    tokenSaverTier,
    isSubagent: scenarioOutcome.isSubagent,
    orchestrating: false,
    resolvedFrom,
    mutations: {},
  };

  const alreadyOrchestrating = sticky?.orchestrating === true;
  const tokenSaverActive = config.tokenSaver?.enabled === true && tokenSaverTier != null;
  const orchGate = tokenSaverActive || alreadyOrchestrating;
  routerLogger.info(
    `decision: tier=${tokenSaverTier}, model=${selection.provider}/${selection.model}, orchGate=${orchGate}, alreadyOrch=${alreadyOrchestrating}, resolvedFrom=${resolvedFrom}`,
  );

  let mutations: RouterMutationsLog = {};
  if (cacheAwareSwitch) {
    mutations = { ...mutations, cacheAwareSwitch };
  }
  if (config.autoOrchestrate?.enabled && orchGate) {
    const orchestrated = applyOrchestration({
      config: config.autoOrchestrate,
      isMainAgent: input.isMainAgent,
      tier: tokenSaverTier,
      alreadyOrchestrating,
    });
    if (orchestrated.applied) {
      mutations = { ...mutations, ...orchestrated.mutations };
      decision.orchestrating = true;
    }
  }

  if (scenarioOutcome.subagentModelHint || decision.isSubagent) {
    mutations = { ...mutations, subagentTagStripped: true };
  }

  const mediaMessages = decision.requestPatch?.messages ?? input.request.messages;
  mutations = rerouteDecisionForMedia(decision, mediaMessages, mutations, config, deps.modelRuntime);
  // 注：媒体重路由可能改掉 decision.provider/model/resolvedFrom（与抽出前一致）。

  decision.mutations = mutations;

  sessionStore.set({
    sessionId: input.sessionId,
    isSubagent: !input.isMainAgent,
    tokenSaverTier,
    stickyProvider: decision.provider,
    stickyModel: decision.model,
    orchestrating: decision.orchestrating,
    lastUsage: sticky?.lastUsage,
    updatedAt: (deps.now?.() ?? new Date()).getTime(),
  });

  events.emit({
    type: "sati_router_decision",
    sessionId: input.sessionId,
    decision,
  });

  return decision;
}
