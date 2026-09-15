/**
 * 模型请求装配：把消息、工具面、系统提示与缓存布局组装成 provider 无关的
 * `CanonicalModelRequest`，并提供预算评估器（候选请求 → token 预算快照）。
 * 抽取自 AgentLoop（issue #147 / TD-SIZE-001）。
 *
 * 「模型可见 = 已记录」纪律在本模块收口：动态注入段落（记忆/指令/方法论/
 * 账本/元认知）既进 system prompt 又落 injected_context 审计，且同 turn 内
 * 相同 source+text 只落库一次；预算预演（previewOnly）不落库也不推进缓存代数。
 */

import {
  cloneMessages,
  materializeMediaReferences,
  type CanonicalMessage,
  type CanonicalModelRequest,
  type CanonicalUsage,
} from "../../model/index.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import { promptCacheEnabled, resolveRequestCachePlan } from "../../context/cache/CachePlan.js";
import type { TokenBudgetSnapshot } from "../../context/index.js";
import type { RouterDecision } from "../../router/index.js";
import { renderWorkspaceLedgerBlock, type WorkspaceLedgerBlock } from "../../session/workspace/WorkspaceLedger.js";
import { createLogger, logger } from "../../telemetry/index.js";
import { requiresPromptCapability } from "../../tool/userInteractionConstraints.js";
import { defaultAgentThinking } from "../../model/thinking/registry.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { applyMethodologyAddendum, computeMethodologyAddendum } from "./methodologyInjection.js";
import { buildMetacognitivePrompt } from "./metacognitiveControl.js";
import { filterAskModeTools, toolToCanonicalSchema, type LifecycleDispatcher } from "./misc.js";
import { appendPlanModeReminder, normalizeMessagesForModelRequest } from "./messages.js";
import { tokensFromUsage } from "./modelErrors.js";
import type { TurnRuntimeState } from "./turnRuntimeState.js";

const agentLogger = createLogger("agent");
/** A5: prompt cache plan 的进程级单调代数（诊断用，随每次规划递增）。 */
let promptCacheGeneration = 0;

/**
 * 请求装配依赖：本模块读取 config 与 dependencies 的大部分面（工具面、协议、
 * 上下文运行时、提示装配），沿用 ToolContextFactory 的"子系统收 config +
 * dependencies"写法，不做逐字段收窄。
 */
export interface ModelRequestDeps {
  readonly config: AgentRuntimeConfig;
  readonly dependencies: AgentRuntimeDependencies;
  readonly dispatchLifecycle: LifecycleDispatcher;
}

/**
 * 装配选项：`emitInstructionEvents: false` 用于预算预演候选请求（不落注入审计、
 * 不推进缓存代数）；`state` 供同 turn 注入去重（reportedInjectionKeys）。
 */
export interface ModelRequestOptions {
  emitInstructionEvents?: boolean;
  state?: TurnRuntimeState;
  previewOnly?: boolean;
}

/**
 * Read and render the current workspace ledger block (empty when disabled).
 * Re-reading fresh from the store (backed by the transcript) is what lets the
 * ledger survive compaction — the block is injected as a system-prompt
 * addendum rather than living in message history.
 *
 * An unreadable transcript yields `status: "unavailable"`; the store has already
 * logged why, and there is no authoritative ledger to inject, so the block is
 * simply omitted rather than fabricated from stale in-memory state.
 */
async function readWorkspaceLedgerBlock(deps: ModelRequestDeps): Promise<WorkspaceLedgerBlock | undefined> {
  if (deps.config.workspaceLedger !== true || !deps.dependencies.workspaceLedger) {
    return undefined;
  }
  try {
    const snapshot = await deps.dependencies.workspaceLedger.read();
    if (snapshot.status !== "ok" || snapshot.state === undefined) return undefined;
    const rendered = renderWorkspaceLedgerBlock(snapshot.state);
    return rendered.empty ? undefined : rendered;
  } catch (error) {
    // Ledger read must never block the request.
    agentLogger.debug(`workspace ledger read failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function createModelRequest(
  deps: ModelRequestDeps,
  messages: CanonicalMessage[],
  input: AgentLoopInput,
  options: ModelRequestOptions = {},
): Promise<CanonicalModelRequest> {
  const contextRuntime = deps.dependencies.context ?? new NullContextRuntime();
  const planTodo = deps.dependencies.planTodoManager?.forSession(input.sessionId);
  const canPrompt = input.canPrompt ?? deps.config.permissionContext.canPrompt;
  const promptBlockedToolNames = canPrompt
    ? new Set<string>()
    : new Set(
        deps.dependencies.tools.registry
          .list()
          .filter(tool => requiresPromptCapability(tool, {}))
          .map(tool => tool.name),
      );
  let toolDefinitions = deps.dependencies.tools.registry.list().filter(tool => !promptBlockedToolNames.has(tool.name));
  if (input.allowPlanModeTools !== true) {
    toolDefinitions = toolDefinitions.filter(tool => tool.name !== "enter_plan_mode" && tool.name !== "exit_plan_mode");
  }
  const requestMessages = normalizeMessagesForModelRequest(messages);
  let tools = toolDefinitions.map(toolToCanonicalSchema);
  if (deps.config.runMode === "ask") {
    tools = filterAskModeTools(toolDefinitions);
  }
  const workspaceLedgerBlock = await readWorkspaceLedgerBlock(deps);
  // Computed once so the model-visible prompt and the injected_context audit
  // record the exact same text (模型可见 = 已记录).
  const metacognitiveAddendum = deps.config.metacognitiveControl
    ? (deps.config.metacognitivePrompt ?? buildMetacognitivePrompt())
    : undefined;
  const prepared = await contextRuntime.prepareForModel({
    previewOnly: options.previewOnly,
    sessionId: input.sessionId,
    turnId: input.turnId,
    cwd: deps.config.cwd,
    provider: deps.config.provider,
    model: deps.config.model,
    permissionMode: deps.config.permissionMode,
    runMode: deps.config.runMode ?? "agent",
    additionalWorkingDirectories: deps.config.permissionContext.additionalWorkingDirectories,
    messages: cloneMessages(requestMessages),
    tools,
    maxMessages: deps.config.maxContextMessages,
    customSystemPrompt: deps.config.systemPrompt,
    appendSystemPrompt:
      [input.appendSystemPrompt, planTodo?.buildPromptAddendum(), workspaceLedgerBlock?.block, metacognitiveAddendum]
        .filter(Boolean)
        .join("\n\n") || undefined,
    abortSignal: input.abortSignal,
  });

  if (options.emitInstructionEvents !== false) {
    deps
      .dispatchLifecycle(input, "InstructionsLoaded", {
        hasSystemPrompt: !!prepared.systemPrompt,
      })
      .catch(error => agentLogger.warn("InstructionsLoaded lifecycle dispatch failed:", error));
    deps.dependencies.eventEmitter?.({
      type: "instructions_loaded",
      sessionId: input.sessionId,
      turnId: input.turnId,
      hasSystemPrompt: !!prepared.systemPrompt,
    });
  }

  const materialized = await materializeMediaReferences(prepared.messages);
  for (const diagnostic of materialized.diagnostics) {
    logger.warn(`${diagnostic.code}: ${diagnostic.message} (${diagnostic.mediaType}, ${diagnostic.path})`);
  }

  // 单次计算方法论 addendum：既落库审计又拼 system prompt，避免同一 inject
  // 回调执行两次导致「记录文本 ≠ 模型实际所见」。
  const methodologyAddendum = computeMethodologyAddendum(requestMessages, deps.config.methodologyInjection);

  // 「模型可见 = 已记录」：动态注入段落（记忆/指令/方法论）作为带 source
  // 标记的参考条目落 transcript（injected_context，重放投影不进入 messages）。
  // 仅真实请求路径（emitInstructionEvents 默认 true）落库；预算评估候选
  // 请求（emitInstructionEvents: false）不重复记录。工具循环每轮都会重新
  // prepareForModel 收集注入，相同 source+text 在同 turn 内只落库一次。
  if (options.emitInstructionEvents !== false) {
    const injections = [...(prepared.injections ?? [])];
    if (methodologyAddendum) {
      injections.push({ source: "methodology", text: methodologyAddendum });
    }
    if (workspaceLedgerBlock && !workspaceLedgerBlock.empty) {
      injections.push({ source: "workspace_ledger", text: workspaceLedgerBlock.block });
    }
    if (metacognitiveAddendum) {
      injections.push({ source: "metacognitive", text: metacognitiveAddendum });
    }
    const freshInjections = injections.filter(injection => {
      const key = `${injection.source}\u0000${injection.text}`;
      if (options.state?.reportedInjectionKeys.has(key)) {
        return false;
      }
      options.state?.reportedInjectionKeys.add(key);
      return true;
    });
    if (freshInjections.length > 0) {
      await input.onInjectedContext?.({ injections: freshInjections });
    }
  }

  return {
    provider: deps.config.provider,
    model: deps.config.model,
    messages:
      deps.config.permissionMode === "plan" ? appendPlanModeReminder(materialized.messages) : materialized.messages,
    systemPrompt: applyMethodologyAddendum(
      prepared.systemPrompt ?? deps.config.systemPrompt ?? "",
      methodologyAddendum,
    ),
    tools: prepared.tools,
    toolChoice: deps.config.toolChoice,
    maxOutputTokens: deps.config.maxOutputTokens,
    temperature: deps.config.temperature,
    thinking: deps.config.thinking ?? defaultAgentThinking(deps.config.model),
    stream: true,
    // 阶段四 T4.2：请求级 retryScope——把 turnId 并入请求 metadata，使
    // streamModel 的 retryId 在同一 turn 的全部请求间稳定（跨路由 attempt
    // 与重试可审计关联）。Anthropic 降级只读 user_id；OpenAI 作为自定义
    // metadata 透传（可用于仪表盘请求关联）。
    metadata: { ...deps.config.metadata, turnId: input.turnId },
    cacheBreakpoints: prepared.cacheBreakpoints,
    // A5：Anthropic per-request 稳定缓存布局（system + recent3）。仅在
    // anthropic 协议、无显式微压缩断点、环境开关开启时规划；逐调用可变
    // 注入（账本/提醒）位于消息尾部，不破坏断点前缀。
    cachePlan: resolveRequestCachePlan(
      {
        provider: deps.config.provider,
        model: deps.config.model,
        systemPrompt: prepared.systemPrompt ?? deps.config.systemPrompt,
        tools: prepared.tools,
        messages: materialized.messages,
        enabled: promptCacheEnabled() && deps.dependencies.getProviderProtocol?.(deps.config.provider) === "anthropic",
        explicitBreakpoints: prepared.cacheBreakpoints,
      },
      // 预算预演不递增 generation：候选请求会被丢弃，否则计数器被假设历史推高。
      options.previewOnly ? promptCacheGeneration : ++promptCacheGeneration,
    ),
  };
}

export type TokenBudgetEvaluator = (
  candidateMessages: CanonicalMessage[],
  lastUsage?: CanonicalUsage,
) => Promise<TokenBudgetSnapshot>;

/**
 * 预算评估器：对候选消息序列装配一次预演请求（不落注入审计、不推进缓存代数），
 * 交给 tokenAccounting 估算；路由模型与默认模型上下文窗口不同时，先按路由决策
 * 物化请求再估算。无 tokenAccounting 或无上下文上限时返回 undefined（调用方
 * 跳过预算评估）。
 */
export function createBudgetEvaluator(
  deps: ModelRequestDeps,
  input: AgentLoopInput,
  options: {
    decision?: RouterDecision;
    baseRequest?: CanonicalModelRequest;
    maxContextTokens?: number;
    reservedOutputTokens: number;
  },
): TokenBudgetEvaluator | undefined {
  const tokenAccounting = deps.dependencies.tokenAccounting;
  const maxContextTokens = options.maxContextTokens;
  if (!tokenAccounting || !maxContextTokens) {
    return undefined;
  }
  return async (candidateMessages, lastUsage) => {
    let candidateRequest = await createModelRequest(deps, candidateMessages, input, {
      emitInstructionEvents: false,
      // 候选请求只用于预算估算，不得提交提示日期锚点与通知位置。
      previewOnly: true,
    });
    if (options.decision && options.baseRequest && deps.dependencies.router.materializeRequest) {
      const patchedBase = { ...options.baseRequest, messages: candidateRequest.messages };
      candidateRequest = deps.dependencies.router.materializeRequest(options.decision, {
        ...patchedBase,
        systemPrompt: candidateRequest.systemPrompt,
        tools: candidateRequest.tools,
        cacheBreakpoints: candidateRequest.cacheBreakpoints,
      });
    }
    const snapshot = await tokenAccounting.evaluateRequestBudget(candidateRequest, {
      maxContextTokens,
      reservedOutputTokens: options.reservedOutputTokens,
      signal: input.abortSignal,
      usePadding: true,
    });
    const usageTokens = tokensFromUsage(lastUsage);
    if (usageTokens === undefined || usageTokens <= snapshot.tokens) {
      return snapshot;
    }
    return tokenAccounting.snapshotFromTokens(usageTokens, maxContextTokens, {
      reservedOutputTokens: options.reservedOutputTokens,
      usageTokens,
      budgetTokens: snapshot.budgetTokens,
      source: snapshot.source,
      exact: snapshot.exact,
      estimatorError: snapshot.estimatorError,
    });
  };
}
