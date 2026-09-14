/**
 * 模型错误恢复链：把 `AgentLoop.handleModelError` 本体（约 10 条互斥恢复
 * 路径并列 364 行）拆为有序步骤函数 + 单一调度入口。抽取自 AgentLoop
 * （issue #147 / TD-AGENT-101）。
 *
 * **顺序即语义**：每条路径返回 handled（`continue`/`return`）即接管本次错误，
 * 只有返回 `unhandled` 才落到下一条；末尾 `surfaceModelError` 是兜底错误面。
 * 重排这些步骤会改变恢复行为（例如 reactive 探针必须在补齐工具结果之后调用）。
 */

import {
  textFromMessage,
  type AssembledAssistantMessage,
  type CanonicalMessage,
  type CanonicalModelError,
  type CanonicalModelRequest,
  type CanonicalToolCall,
} from "../../model/index.js";
import type { ContextRecoveryDecision, TokenBudgetSnapshot } from "../../context/index.js";
import type { PermissionMode } from "../../permission/index.js";
import type { RouterDecision } from "../../router/index.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentLoopInput } from "../protocol/input.js";
import { createMissingToolResult } from "./ensureToolResultPairing.js";
import {
  addEmptyReasoningContentMarkers,
  buildPartialTextToolCallRecoveryPrompt,
  buildStreamInterruptionRecoveryPrompt,
  isMissingReasoningContentError,
  safeFinalTextMessage,
  stripImagesFromMessages,
  stripTrailingErrorPair,
  truncateHeadKeepRatio,
  withoutThinkingBlocks,
} from "./messages.js";
import type { LifecycleDispatcher } from "./misc.js";
import {
  classifyModelError,
  createModelRequestFailedStatus,
  modelErrorTarget,
  parseOutputCapRejection,
} from "./modelErrors.js";
import { projectToolResults } from "./projectToolResults.js";
import { continueWithTransientPrompt, recoverFromMaxOutputBump } from "./recoveryStrategies.js";
import {
  MAX_JSON_SELF_CORRECT_RETRIES,
  MAX_STREAM_INTERRUPTION_RECOVERIES,
  type TurnRuntimeState,
} from "./turnRuntimeState.js";
import {
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  unhandled,
  type StageOutcome,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "./turnExit.js";

/** 已接管的结论：回主循环（continue）或终止本轮（return）。 */
export type RecoveryHandled = TurnStepContinue | TurnStepReturn;

/**
 * 恢复链调用 `AgentLoop.runAutoCompact` 的窄接口：只声明本链使用的
 * `model-error-recovery` 一路参数（其余阶段的参数留在 AgentLoop）。
 */
export type AutoCompactRunner = (
  state: TurnRuntimeState,
  input: AgentLoopInput,
  options: {
    stage: "model-error-recovery";
    maxContextTokens?: number;
    reservedOutputTokens: number;
    emitAutoCompactEvent?: boolean;
    fallbackTruncateRatio?: number;
  },
) => AsyncGenerator<AgentEvent, { compacted: boolean; snapshot?: TokenBudgetSnapshot }, unknown>;

/**
 * 恢复链依赖袋：tokenCaps/contextRuntime/now 承接自 TurnExitDeps（终局与
 * 状态发射复用），其余为配置派生项与 AgentLoop 侧的执行器。
 */
export interface ModelErrorRecoveryDeps extends TurnExitDeps {
  /** config.jsonSelfCorrect：invalid_tool_arguments 是否走模型自纠重试。 */
  readonly jsonSelfCorrect: boolean | undefined;
  /** 补齐缺失工具结果所需的上下文（config 派生）。 */
  readonly missingToolResultRecoveryContext: () => { cwd: string; permissionMode: PermissionMode };
  readonly dispatchLifecycle: LifecycleDispatcher;
  readonly runAutoCompact: AutoCompactRunner;
}

/** 反应式恢复探针：context runtime 未接线或探针抛错时视为放弃恢复。 */
async function tryReactiveRecover(
  deps: ModelErrorRecoveryDeps,
  input: AgentLoopInput,
  error: CanonicalModelError,
  messages: CanonicalMessage[],
  hasAttemptedCompact: boolean,
): Promise<ContextRecoveryDecision | undefined> {
  const ctx = deps.contextRuntime;
  if (!ctx?.recoverFromModelError) {
    return undefined;
  }
  try {
    return await ctx.recoverFromModelError({
      sessionId: input.sessionId,
      turnId: input.turnId,
      error,
      messages,
      hasAttemptedCompact,
    });
  } catch {
    // Recovery probe should never block fallback. Pretend the runtime gave up.
    return undefined;
  }
}

/**
 * 输出上限自愈（W4）：provider 对超出模型上限的 max_tokens 返回 400 并
 * 在文案中指名上限。学到天花板写入 session 级 hardMaxOutputTokens（
 * TokenCapManager 跨 turn 保留），隐形重试一次（400 发生在任何流内容
 * 之前，重发幂等）。
 */
export async function* learnOutputCapFromRejection(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  request: CanonicalModelRequest,
  decision: RouterDecision,
  error: CanonicalModelError,
  routedMaxOutputTokens: number | undefined,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  if (state.hasAttemptedOutputCapRetry) return unhandled();
  // 实际发送值（applyTokenCapsToRequest 之后）优先于 catalog 路由值：
  // config 钳得比 catalog 低时，报错文案回显的请求值才是对拍基准。
  const requestedOutput = request.maxOutputTokens ?? routedMaxOutputTokens;
  const learnedCap = parseOutputCapRejection(error, requestedOutput);
  if (learnedCap === null) return unhandled();
  state.hasAttemptedOutputCapRetry = true;
  const target = modelErrorTarget(error, decision.provider, decision.model);
  deps.tokenCaps.setTransientTokenCap(target.provider, target.model, {
    hardMaxOutputTokens: learnedCap,
  });
  yield {
    type: "warning",
    sessionId: input.sessionId,
    turnId: input.turnId,
    code: "output_cap_learned",
    message: `Provider rejected max_output_tokens ${requestedOutput ?? "(default)"}; learned cap ${learnedCap} and retrying.`,
    metadata: { provider: target.provider, model: target.model, learnedCap },
  };
  yield {
    type: "turn_continued",
    sessionId: input.sessionId,
    turnId: input.turnId,
    reason: "model_error",
  };
  return { kind: "continue" };
}

/**
 * 流中断恢复：streamModel 在流完成前断连（idle 超时/连接断开/网络错误）
 * 时以 streamInterruption 错误上抛，不再整体重试（会重复已收到的文本）。
 * 已产生的部分内容按中断阶段处理：phase=text 且无工具片段 → 可见文本先
 * 落库再续接；有任何工具片段 → 绝不落库（恢复响应到达前被取消也不把
 * 半截工具调用作为最终消息）。最多 MAX_STREAM_INTERRUPTION_RECOVERIES
 * 次；耗尽走错误面。
 */
export async function* recoverFromStreamInterruption(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  error: CanonicalModelError,
  assembled: AssembledAssistantMessage,
  toolCalls: CanonicalToolCall[],
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  const interruption = error.streamInterruption;
  if (!interruption) return unhandled();

  if (state.streamInterruptionRecoveryCount < MAX_STREAM_INTERRUPTION_RECOVERIES) {
    state.streamInterruptionRecoveryCount++;
    const hasTextToolCall =
      assembled.hasPartialTextToolCall || assembled.hasTextFallbackToolCalls || toolCalls.length > 0;
    if (hasTextToolCall) {
      state.finalMessage = undefined;
    } else {
      const partialTextMessage = withoutThinkingBlocks(assembled.message);
      const hasVisibleText = textFromMessage(partialTextMessage).trim().length > 0;
      if (interruption.phase === "text" && hasVisibleText) {
        state.finalMessage = partialTextMessage;
        state.messages.push(partialTextMessage);
        yield {
          type: "assistant_message",
          sessionId: input.sessionId,
          turnId: input.turnId,
          message: partialTextMessage,
        };
        await input.onDurableMessage?.(partialTextMessage);
      } else {
        // reasoning/empty 阶段中断（或无可保留文本）：恢复响应到达前被
        // 取消时，不得把 thinking-only 原始消息作为最终消息持久化。
        state.finalMessage = undefined;
      }
    }
    const recoveryPrompt = hasTextToolCall
      ? buildPartialTextToolCallRecoveryPrompt(assembled.partialTextToolCall)
      : buildStreamInterruptionRecoveryPrompt(interruption);
    return yield* continueWithTransientPrompt(
      state,
      input,
      recoveryPrompt,
      hasTextToolCall ? "max_output_recovery" : "stream_interruption_recovery",
    );
  }

  const exhaustedError = agentError(
    "agent_model_error",
    `Stream interruption recovery exhausted after ${MAX_STREAM_INTERRUPTION_RECOVERIES} attempts (${interruption.phase}).`,
    error,
    "The model stream repeatedly disconnected. Retry the turn or switch providers.",
  );
  const exhaustedMessage = safeFinalTextMessage(
    assembled.message,
    assembled.hasPartialTextToolCall || assembled.hasTextFallbackToolCalls,
    toolCalls,
  );
  state.finalMessage = exhaustedMessage;
  if (exhaustedMessage) {
    state.messages.push(exhaustedMessage);
    yield {
      type: "assistant_message",
      sessionId: input.sessionId,
      turnId: input.turnId,
      message: exhaustedMessage,
    };
    await input.onDurableMessage?.(exhaustedMessage);
  }
  await deps.dispatchLifecycle(input, "StopFailure", { error: exhaustedError.message });
  yield {
    type: "stop_failure",
    sessionId: input.sessionId,
    turnId: input.turnId,
    error: exhaustedError.message,
  };
  const result = createTurnResult(input, {
    type: "error",
    stopReason: "model_error",
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    turns: state.turnCount,
    startedAt: state.startedAt,
    finalMessage: state.finalMessage,
    structuredOutput: state.structuredOutput,
    errors: [exhaustedError],
  });
  yield await emitStatus(input, createModelRequestFailedStatus({ error: exhaustedError, modelError: error }));
  return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
}

/** 推理内容缺失（部分 provider 要求回填空 reasoning 标记）单次重试。 */
export async function* retryMissingReasoningContent(
  state: TurnRuntimeState,
  input: AgentLoopInput,
  error: CanonicalModelError,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  if (state.hasAttemptedReasoningContentRetry || !isMissingReasoningContentError(error)) return unhandled();
  state.hasAttemptedReasoningContentRetry = true;
  state.messages = addEmptyReasoningContentMarkers(state.messages);
  yield {
    type: "turn_continued",
    sessionId: input.sessionId,
    turnId: input.turnId,
    reason: "model_error",
  };
  return { kind: "continue" };
}

/**
 * 为报错前已发起、但未能执行的工具调用补齐结果块：不补齐则下一次请求带着
 * 无结果的 tool_call 发送，provider 直接拒绝。
 */
export async function* projectMissingToolResults(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  toolCalls: CanonicalToolCall[],
): AsyncGenerator<AgentEvent, void, unknown> {
  if (toolCalls.length === 0) return;
  const projected = projectToolResults(
    toolCalls.map(call =>
      createMissingToolResult(
        call,
        deps.now,
        "Model error interrupted tool execution.",
        deps.missingToolResultRecoveryContext(),
      ),
    ),
  );
  state.messages.push(...projected);
  yield {
    type: "tool_results_projected",
    sessionId: input.sessionId,
    turnId: input.turnId,
    message: projected[0]!,
  };
  for (const msg of projected) {
    await input.onDurableMessage?.(msg);
  }
}

/** 工具参数非法 JSON 的模型自纠（有界 MAX_JSON_SELF_CORRECT_RETRIES 次）。 */
export async function* recoverFromJsonSelfCorrect(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  error: CanonicalModelError,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  if (
    !deps.jsonSelfCorrect ||
    error.code !== "invalid_tool_arguments" ||
    state.jsonSelfCorrectCount >= MAX_JSON_SELF_CORRECT_RETRIES
  ) {
    return unhandled();
  }
  state.jsonSelfCorrectCount++;
  return yield* continueWithTransientPrompt(
    state,
    input,
    "Your previous tool call contained invalid JSON in the arguments and could not be parsed. " +
      "Please retry with valid JSON. Common issues: missing quotes around keys/values, " +
      "trailing commas, unescaped special characters in strings.",
    "json_self_correct",
  );
}

/**
 * 反应式恢复：问 context runtime 能否从该错误恢复（如 `prompt_too_long` →
 * 截头重试）。探针每轮一次 —— 见 legacy parity §3.1 #8。
 */
export async function* recoverFromReactiveDecision(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  decision: RouterDecision,
  error: CanonicalModelError,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  const reactive = await tryReactiveRecover(deps, input, error, state.messages, state.hasAttemptedCompact);
  if (!reactive) return unhandled();

  if (reactive.type === "adjust_output_and_retry" && !state.hasAttemptedOutputRetry) {
    state.hasAttemptedOutputRetry = true;
    const target = modelErrorTarget(error, decision.provider, decision.model);
    const previousOutput = deps.tokenCaps.currentMaxOutputTokens(target.provider, target.model);
    deps.tokenCaps.setTransientTokenCap(
      target.provider,
      target.model,
      reactive.scope === "attempt"
        ? { attemptMaxOutputTokens: reactive.maxOutputTokens }
        : { hardMaxOutputTokens: reactive.maxOutputTokens },
    );
    if (target.provider !== decision.provider || target.model !== decision.model) {
      deps.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
        attemptMaxOutputTokens: reactive.maxOutputTokens,
      });
    }
    state.messages = stripTrailingErrorPair(state.messages);
    yield {
      type: "token_cap_adjusted",
      sessionId: input.sessionId,
      turnId: input.turnId,
      provider: target.provider,
      model: target.model,
      cap: "output",
      previous: previousOutput,
      next: reactive.maxOutputTokens,
      reason: reactive.reason,
    };
    yield {
      type: "turn_continued",
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: "model_error",
    };
    return { kind: "continue" };
  }

  if (reactive.type === "compact_and_retry" && !state.hasAttemptedCompact) {
    const target = modelErrorTarget(error, decision.provider, decision.model);
    const previousContext = deps.tokenCaps.currentMaxContextTokens(target.provider, target.model);
    if (reactive.maxContextTokens !== undefined) {
      deps.tokenCaps.setTransientTokenCap(target.provider, target.model, {
        maxContextTokens: reactive.maxContextTokens,
      });
      yield {
        type: "token_cap_adjusted",
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: target.provider,
        model: target.model,
        cap: "context",
        previous: previousContext,
        next: reactive.maxContextTokens,
        reason: reactive.reason,
      };
    }
    if (reactive.maxOutputTokens !== undefined) {
      const previousOutput = deps.tokenCaps.currentMaxOutputTokens(target.provider, target.model);
      deps.tokenCaps.setTransientTokenCap(target.provider, target.model, {
        attemptMaxOutputTokens: reactive.maxOutputTokens,
      });
      if (target.provider !== decision.provider || target.model !== decision.model) {
        deps.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
          attemptMaxOutputTokens: reactive.maxOutputTokens,
        });
      }
      yield {
        type: "token_cap_adjusted",
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: target.provider,
        model: target.model,
        cap: "output",
        previous: previousOutput,
        next: reactive.maxOutputTokens,
        reason: reactive.reason,
      };
    }
    state.messages = stripTrailingErrorPair(state.messages);
    if (deps.contextRuntime?.tryAutoCompact) {
      yield* deps.runAutoCompact(state, input, {
        stage: "model-error-recovery",
        maxContextTokens: deps.tokenCaps.currentMaxContextTokens(target.provider, target.model),
        reservedOutputTokens: deps.tokenCaps.getReservedOutputTokens(target.provider, target.model),
        emitAutoCompactEvent: false,
        fallbackTruncateRatio: 0.5,
      });
    } else {
      state.messages = truncateHeadKeepRatio(state.messages, 0.5);
    }
    state.hasAttemptedCompact = true;
    yield {
      type: "turn_continued",
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: "model_error",
    };
    return { kind: "continue" };
  }

  if (reactive.type === "truncate_head_and_retry") {
    // Drop the failed assistant message + any synthetic tool_result we just
    // pushed so the retry doesn't carry a half-baked tool_call. Then apply
    // keepRatio so the cap is computed against valid history only.
    state.messages = stripTrailingErrorPair(state.messages);
    state.messages = truncateHeadKeepRatio(state.messages, reactive.keepRatio);
    state.hasAttemptedCompact = true;
    yield {
      type: "turn_continued",
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: "model_error",
    };
    return { kind: "continue" };
  }

  if (reactive.type === "strip_images_and_retry") {
    state.messages = stripTrailingErrorPair(state.messages);
    state.messages = stripImagesFromMessages(state.messages);
    yield {
      type: "turn_continued",
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: "model_error",
    };
    return { kind: "continue" };
  }

  return unhandled();
}

/**
 * `max_output_reached`: output token limit hit (or truncated JSON
 * reclassified from invalid_tool_arguments when finishReason=length).
 *
 * Phase A — single-shot token doubling for explicit caps only.
 * Phase B — multi-turn continuation: keep the truncated assistant
 * message in context and inject a "resume" prompt so the model can
 * pick up where it was cut off (up to MAX_OUTPUT_RECOVERY_LIMIT).
 * Phase C — exhausted: fall through to error surfacing.
 */
export async function* recoverFromMaxOutputLimit(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  decision: RouterDecision,
  error: CanonicalModelError,
  routedMaxOutputTokens: number | undefined,
): AsyncGenerator<AgentEvent, StageOutcome, unknown> {
  if (error.code !== "max_output_reached") return unhandled();
  // 输出触顶的响应含截断内容（可能带半截工具调用语法）：Phase A/B 恢复
  // 响应到达前被取消时，绝不能把原始消息作为最终消息持久化
  // （与 partial-text 恢复路径的清理一致，经由 helper 的 strip 选项实现）。
  state.finalMessage = undefined;
  const recovery = yield* recoverFromMaxOutputBump(deps, state, input, decision, routedMaxOutputTokens, {
    stripTrailingErrorPairMessages: true,
  });
  if (recovery !== "exhausted") {
    return { kind: "continue" };
  }
  return unhandled();
}

/**
 * 兜底错误面：分类错误、广播 stop_failure、以 error 结果收尾。
 *
 * Cross-provider fallback decisions are now owned by RouterRuntime
 * (see `runFallbackChain` + `zeroUsageRetry`); the loop only
 * classifies the surfaced error and falls through.
 */
export async function* surfaceModelError(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  error: CanonicalModelError,
): AsyncGenerator<AgentEvent, TurnStepReturn, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  const classified = classifyModelError(error);
  await deps.dispatchLifecycle(input, "StopFailure", { error });
  yield {
    type: "stop_failure",
    sessionId: input.sessionId,
    turnId: input.turnId,
    error: typeof error === "string" ? error : JSON.stringify(error),
  };
  const result = createTurnResult(input, {
    type: "error",
    stopReason: classified.stopReason,
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    turns: state.turnCount,
    startedAt: state.startedAt,
    finalMessage: state.finalMessage,
    errors: [classified.error],
  });
  yield await emitStatus(
    input,
    createModelRequestFailedStatus({
      error: classified.error,
      modelError: error,
    }),
  );
  return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
}

/**
 * 恢复链调度入口：按顺序尝试各条路径，全部 unhandled 时落到错误面。
 * 调用方仅在 `assembled.error` 存在时进入。
 */
export async function* recoverFromModelError(
  deps: ModelErrorRecoveryDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  request: CanonicalModelRequest,
  decision: RouterDecision,
  assembled: AssembledAssistantMessage,
  toolCalls: CanonicalToolCall[],
  routedMaxOutputTokens: number | undefined,
): AsyncGenerator<AgentEvent, RecoveryHandled, unknown> {
  const error = assembled.error;
  if (!error) return { kind: "continue" };

  const capped = yield* learnOutputCapFromRejection(
    deps,
    state,
    input,
    request,
    decision,
    error,
    routedMaxOutputTokens,
  );
  if (capped.kind !== "unhandled") return capped;

  const interrupted = yield* recoverFromStreamInterruption(deps, state, input, error, assembled, toolCalls);
  if (interrupted.kind !== "unhandled") return interrupted;
  // 非流中断错误：连续中断计数清零，下次中断可独立恢复（原有语义）。
  state.streamInterruptionRecoveryCount = 0;

  const reasoning = yield* retryMissingReasoningContent(state, input, error);
  if (reasoning.kind !== "unhandled") return reasoning;

  yield* projectMissingToolResults(deps, state, input, toolCalls);

  const selfCorrect = yield* recoverFromJsonSelfCorrect(deps, state, input, error);
  if (selfCorrect.kind !== "unhandled") return selfCorrect;

  const reactive = yield* recoverFromReactiveDecision(deps, state, input, decision, error);
  if (reactive.kind !== "unhandled") return reactive;

  const outputLimit = yield* recoverFromMaxOutputLimit(deps, state, input, decision, error, routedMaxOutputTokens);
  if (outputLimit.kind !== "unhandled") return outputLimit;

  return yield* surfaceModelError(deps, state, input, error);
}
