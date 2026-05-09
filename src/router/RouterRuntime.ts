import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
} from "../model/index.js";
import type {
  RouterConfig,
  RouterModelRef,
} from "./config/schema.js";
import type {
  PolitDeckCustomRouter,
  CustomRouterRegistry,
} from "./customRouter/customRouter.js";
import { noopCustomRouterRegistry } from "./customRouter/customRouter.js";
import { isFallbackEligible, planFallback } from "./fallback/runFallbackChain.js";
import { applyOrchestration } from "./orchestrate/applyOrchestration.js";
import type {
  RouterDecision,
  RouterDecisionInput,
  RouterExecuteContext,
  RouterMutationsLog,
  RouterScenarioType,
} from "./protocol/decision.js";
import type { RouterEvent, RouterEventBus } from "./protocol/events.js";
import { decideScenario } from "./scenario/decideScenario.js";
import { stripSubagentTagFromMessages } from "./scenario/subagentDetector.js";
import { SessionRouterStore } from "./session/SessionRouterStore.js";
import { SessionUsageCache } from "./session/sessionUsageCache.js";
import {
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "./retry/zeroUsageRetry.js";
import { TokenStatsCollector } from "./stats/TokenStatsCollector.js";
import { classifyAndRoute } from "./tokenSaver/classifyAndRoute.js";

export type RouterRuntimeDeps = {
  modelRuntime: ModelRuntime;
  judgeRuntime?: ModelRuntime;
  customRouterRegistry?: CustomRouterRegistry;
  /** Optional skill prompt loader for AutoOrchestrate; receives extension id, returns text. */
  loadSkillPrompt?: (extensionId: string) => Promise<string | undefined>;
  events?: RouterEventBus;
  now?: () => Date;
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
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean },
  ): AsyncIterable<CanonicalModelEvent>;
  observeUsage(sessionId: string, usage: import("../model/index.js").CanonicalUsage | undefined): void;
  stats: TokenStatsCollector;
  shutdown(): Promise<void>;
};

export function createRouterRuntime(
  config: RouterConfig,
  deps: RouterRuntimeDeps,
): RouterRuntime {
  const stats = new TokenStatsCollector(config.stats);
  const sessionStore = new SessionRouterStore({
    now: () => (deps.now?.() ?? new Date()).getTime(),
  });
  const usageCache = new SessionUsageCache();
  const customRouters = deps.customRouterRegistry ?? noopCustomRouterRegistry;
  const judgeRuntime = deps.judgeRuntime ?? deps.modelRuntime;
  const events = deps.events ?? { emit: () => undefined };

  async function resolveCustom(
    input: RouterDecisionInput,
  ): Promise<Partial<RouterDecision> | undefined> {
    if (!config.customRouter) {
      return undefined;
    }
    const router: PolitDeckCustomRouter | undefined = customRouters.lookupRouter(
      config.customRouter.extensionId,
    );
    if (!router) {
      return undefined;
    }
    try {
      return await router.decide({
        ...input,
        context: {
          sessionId: input.sessionId,
          isMainAgent: input.isMainAgent,
          scenarios: Object.keys(config.scenarios),
        },
      });
    } catch (error) {
      events.emit({
        type: "politdeck_router_custom_failed",
        sessionId: input.sessionId,
        extensionId: config.customRouter.extensionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async function decide(input: RouterDecisionInput): Promise<RouterDecision> {
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

    const custom = await resolveCustom(inputWithUsage);
    const scenarioOutcome = decideScenario(inputWithUsage, config.scenarios);

    let scenarioType: RouterScenarioType = scenarioOutcome.scenarioType;
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
    if (
      !custom?.provider &&
      scenarioType !== "explicit" &&
      config.tokenSaver?.enabled &&
      (input.isMainAgent || config.tokenSaver.subagent?.policy !== "skip")
    ) {
      const tokenSaver = await classifyAndRoute({
        config: config.tokenSaver,
        messages: input.request.messages,
        judgeRuntime,
      });
      if (tokenSaver) {
        if (tokenSaver.failureReason) {
          events.emit({
            type: "politdeck_router_token_saver_failed",
            sessionId: input.sessionId,
            reason: tokenSaver.failureReason,
            fallbackTier: tokenSaver.tier,
          });
        }
        if (tokenSaver.resolvedFrom === "judge" || !selection) {
          selection = tokenSaver.selection;
          resolvedFrom = "tokenSaver";
        }
        tokenSaverTier = tokenSaver.tier;
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
      selection = config.scenarios.default;
      scenarioType = scenarioType === "explicit" ? scenarioType : "default";
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

    let skillPrompt: string | undefined;
    if (
      config.autoOrchestrate?.enabled &&
      input.isMainAgent &&
      config.autoOrchestrate.skillExtensionId &&
      deps.loadSkillPrompt
    ) {
      try {
        skillPrompt = await deps.loadSkillPrompt(config.autoOrchestrate.skillExtensionId);
      } catch {
        skillPrompt = undefined;
      }
    }

    let mutations: RouterMutationsLog = {};
    if (config.autoOrchestrate?.enabled) {
      const orchestrated = applyOrchestration({
        request: input.request,
        config: config.autoOrchestrate,
        isMainAgent: input.isMainAgent,
        tier: tokenSaverTier,
        skillPrompt,
      });
      if (orchestrated.applied) {
        mutations = { ...mutations, ...orchestrated.mutations };
        decision.requestPatch = {
          messages: orchestrated.request.messages,
          tools: orchestrated.request.tools,
          systemPrompt: orchestrated.request.systemPrompt,
        };
        decision.orchestrating = true;
      }
    }

    if (scenarioOutcome.subagentModelHint || decision.isSubagent) {
      mutations = { ...mutations, subagentTagStripped: true };
    }

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
      type: "politdeck_router_decision",
      sessionId: input.sessionId,
      decision,
    });

    return decision;
  }

  function applyDecisionToRequest(
    decision: RouterDecision,
    request: CanonicalModelRequest,
  ): CanonicalModelRequest {
    let messages = decision.requestPatch?.messages ?? request.messages;
    if (decision.mutations.subagentTagStripped) {
      messages = stripSubagentTagFromMessages(messages);
    }
    return {
      ...request,
      ...decision.requestPatch,
      provider: decision.provider,
      model: decision.model,
      messages,
    };
  }

  async function* execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent> {
    const startedAt = (deps.now?.() ?? new Date()).toISOString();
    const fallbackPlan = planFallback(config.fallback, decision.scenarioType);
    const attempts: RouterModelRef[] = [
      { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model },
      ...fallbackPlan.attempts,
    ];
    const zeroUsageMax = Math.max(1, config.zeroUsageRetry?.maxAttempts ?? 5);
    const zeroUsageEnabled = config.zeroUsageRetry?.enabled ?? true;

    let lastBuffered: CanonicalModelEvent[] = [];
    let lastError: import("../model/index.js").CanonicalModelError | undefined;
    let lastUsage: import("../model/index.js").CanonicalUsage | undefined;
    let lastAttempt: RouterModelRef | undefined;
    let lastDecision: RouterDecision = decision;

    outer: for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      if (ctx.abortSignal?.aborted) {
        return;
      }
      const attempt = attempts[attemptIndex];
      const attemptDecision: RouterDecision = {
        ...decision,
        provider: attempt.provider,
        model: attempt.model,
        resolvedFrom: attemptIndex === 0 ? decision.resolvedFrom : "fallback",
      };
      const attemptRequest = applyDecisionToRequest(attemptDecision, request);
      lastAttempt = attempt;
      lastDecision = attemptDecision;

      let zeroUsageAttempt = 0;
      while (true) {
        zeroUsageAttempt += 1;
        // Live-stream events. We track whether we've already surfaced any
        // content event (text/thinking/tool) to the consumer; once we have,
        // fallback / retry is no longer safe (would duplicate text).
        let hasYieldedContent = false;
        const pending: CanonicalModelEvent[] = [];
        let outcome: AttemptOutcome | undefined;

        for await (const item of streamAttempt(attemptRequest, deps.modelRuntime)) {
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
          break outer;
        }

        lastBuffered = outcome.buffered;
        lastUsage = outcome.usage;

        if (outcome.error) {
          lastError = outcome.error;
          // Only retry/fallback if we haven't surfaced content yet — otherwise
          // we'd produce duplicate text on the consumer side.
          if (!hasYieldedContent && isFallbackEligible(outcome.error)) {
            if (attemptIndex < attempts.length - 1) {
              const next = attempts[attemptIndex + 1];
              events.emit({
                type: "politdeck_router_fallback",
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
              continue outer;
            }
          }
          // Either we've already surfaced content, the error isn't eligible
          // for fallback, or we've exhausted the attempt list. Replay any
          // queued framing events then surface the error.
          for (const queued of pending) {
            yield queued;
          }
          break outer;
        }

        if (
          !hasYieldedContent &&
          zeroUsageEnabled &&
          outcome.shouldRetryZeroUsage &&
          zeroUsageAttempt < zeroUsageMax
        ) {
          events.emit({
            type: "politdeck_router_zero_usage_retry",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: zeroUsageAttempt,
            provider: attempt.provider,
            model: attempt.model,
          });
          continue;
        }

        // Success path: flush any pending framing events that didn't reach
        // a content event (e.g. zero-content responses, tool-only turns).
        if (!hasYieldedContent) {
          for (const queued of pending) {
            yield queued;
          }
        }

        const endedAt = (deps.now?.() ?? new Date()).toISOString();
        if (outcome.usage) {
          usageCache.observe(ctx.sessionId, outcome.usage);
        }
        stats.observe({
          sessionId: ctx.sessionId,
          scenarioType: attemptDecision.scenarioType,
          resolvedFrom: attemptDecision.resolvedFrom,
          provider: attempt.provider,
          model: attempt.model,
          usage: outcome.usage ?? {},
          startedAt,
          endedAt,
        });
        return;
      }
    }

    if (lastError && lastAttempt) {
      events.emit({
        type: "politdeck_router_execute_failed",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        scenarioType: lastDecision.scenarioType,
        provider: lastAttempt.provider,
        model: lastAttempt.model,
        error: lastError,
      });
      const endedAt = (deps.now?.() ?? new Date()).toISOString();
      stats.observe({
        sessionId: ctx.sessionId,
        scenarioType: lastDecision.scenarioType,
        resolvedFrom: lastDecision.resolvedFrom,
        provider: lastAttempt.provider,
        model: lastAttempt.model,
        usage: lastUsage ?? {},
        startedAt,
        endedAt,
      });
      for (const event of lastBuffered) {
        if (event.type !== "error") {
          yield event;
        }
      }
      yield { type: "error", error: lastError };
    }
  }

  async function* stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean },
  ): AsyncIterable<CanonicalModelEvent> {
    const decision = await decide({
      request,
      sessionId: ctx.sessionId,
      isMainAgent: ctx.isMainAgent,
    });
    yield* execute(decision, request, ctx);
  }

  return {
    decide,
    execute,
    stream,
    observeUsage(sessionId, usage) {
      usageCache.observe(sessionId, usage);
    },
    stats,
    async shutdown() {
      sessionStore.clear();
      usageCache.clear();
    },
  };
}

type AttemptOutcome = {
  buffered: CanonicalModelEvent[];
  error?: import("../model/index.js").CanonicalModelError;
  usage?: import("../model/index.js").CanonicalUsage;
  shouldRetryZeroUsage: boolean;
};

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
 * Live attempt — yields each model event the moment it arrives, then yields
 * a final `{ outcome }` sentinel with retry/usage metadata. The previous
 * implementation `await`-ed the entire stream into `buffered[]` before
 * returning, which silently broke streaming UX (TUI/CLI saw the assistant
 * text appear in one burst at the end of the turn).
 *
 * Trade-off: zero-usage retry and provider fallback can only fire BEFORE we
 * yield any content. If a provider crashes mid-stream after we've already
 * surfaced text, we can't transparently fall back without leaking duplicate
 * text. This matches OpenAI's / Anthropic's own clients.
 */
async function* streamAttempt(
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
): AsyncGenerator<
  | { kind: "event"; event: CanonicalModelEvent }
  | { kind: "outcome"; outcome: AttemptOutcome }
> {
  const buffered: CanonicalModelEvent[] = [];
  const state = createZeroUsageState();
  let providerError: import("../model/index.js").CanonicalModelError | undefined;

  try {
    for await (const event of modelRuntime.stream(request)) {
      observeEventForZeroUsage(state, event);
      buffered.push(event);
      if (event.type === "error") {
        providerError = event.error;
      }
      yield { kind: "event", event };
    }
  } catch (error) {
    const fromError = (error as { error?: import("../model/index.js").CanonicalModelError })?.error;
    providerError = fromError ?? {
      provider: request.provider,
      protocol: "anthropic",
      code: "unknown",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  yield {
    kind: "outcome",
    outcome: {
      buffered,
      error: providerError,
      usage: state.observedUsage,
      shouldRetryZeroUsage: shouldRetryZeroUsage(state),
    },
  };
}
