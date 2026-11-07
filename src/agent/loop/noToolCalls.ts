/**
 * 无工具调用的模型响应处置（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 顺序即语义（与 responseAssembly 的装配链衔接）：空响应恢复 → 纯文本截断续写
 * → LargeFileRepair 续跑 → 未解析文本工具调用纠正 → Stop 生命周期钩子 →
 * 声称-行动守卫 → 元认知重试 → 正常收尾。
 */

import {
  detectFormatByText,
  getSelfCorrectPrompt,
  textFromMessage,
  type AssembledAssistantMessage,
  type CanonicalMessage,
  type CanonicalModelRequest,
  type CanonicalToolCall,
} from "../../model/index.js";
import type { RouterDecision } from "../../router/index.js";
import type { AgentEvent } from "../protocol/events.js";
import { agentError } from "../protocol/errors.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import { evaluateClaimGuard } from "./claimGuard.js";
import { buildMetacognitiveRetryPrompt, parseSelfEstimate } from "./metacognitiveControl.js";
import { findLifecycleBlock, type LifecycleDispatcher } from "./misc.js";
import {
  createEmptyResponseStatus,
  createFinishReasonStatus,
  createLifecycleBlockedStatus,
  createMaxOutputRecoveryExhaustedStatus,
} from "./modelErrors.js";
import { continueWithTransientPrompt, recoverFromEmptyResponse } from "./recoveryStrategies.js";
import type { SyntheticPromptContinuer } from "./responseAssembly.js";
import {
  emitStatus,
  makeTurnResultBuilder,
  terminateTurn,
  type TurnExitDeps,
  type TurnStepContinue,
  type TurnStepReturn,
} from "./turnExit.js";
import { MAX_OUTPUT_RECOVERY_LIMIT, type TurnRuntimeState } from "./turnRuntimeState.js";

export type NoToolCallsResult = TurnStepContinue | TurnStepReturn;

/** 无工具调用处置依赖袋（AgentLoop 组装注入）。 */
export interface NoToolCallsDeps extends TurnExitDeps {
  readonly config: AgentRuntimeConfig;
  readonly dispatchLifecycle: LifecycleDispatcher;
  readonly continueWithSyntheticPrompt: SyntheticPromptContinuer;
}

/**
 * 响应已装配但模型未发起工具调用：决定是续跑（恢复/纠正）还是收尾。
 *
 * @param assembled 有效的非错误响应（调用方已排除 error 分支）
 */
export async function* handleNoToolCalls(
  deps: NoToolCallsDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  request: CanonicalModelRequest,
  decision: RouterDecision,
  assembled: AssembledAssistantMessage,
  assistantMessage: CanonicalMessage,
  toolCalls: CanonicalToolCall[],
  routedMaxOutputTokens: number | undefined,
): AsyncGenerator<AgentEvent, NoToolCallsResult, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  if (toolCalls.length > 0) {
    return { kind: "continue" };
  }

  const assistantText = textFromMessage(assistantMessage);

  // Global guard: empty assistant response (no text, no tool calls).
  // The model produced nothing visible — typically because extended
  // thinking consumed the entire output budget.
  if (assistantText.length === 0) {
    state.messages.pop();

    const recovery = yield* recoverFromEmptyResponse(
      deps,
      state,
      input,
      decision,
      request,
      assembled.finishReason,
      routedMaxOutputTokens,
    );
    if (recovery === "recovered-return") {
      return { kind: "continue" };
    }
    if (recovery !== "unhandled") {
      return recovery;
    }
    // Exhausted without retry budget: surface a UI-only status message
    // instead of injecting diagnostic assistant text into the transcript.
    const status = createEmptyResponseStatus({
      provider: request.provider,
      model: request.model,
      attempts: 2,
    });
    yield await emitStatus(input, status);
    // fall through to normal stop
  }

  // Pure-text output truncated by max_output_tokens: the model was
  // mid-sentence with no tool calls. Unlike tool-call truncation we
  // skip the "strip-and-retry-with-doubled-tokens" phase (Phase A)
  // because (a) the text already generated is valid and discarding it
  // wastes tokens, and (b) blindly doubling maxOutputTokens may
  // exceed the provider's model cap and trigger a 400 error.
  // Instead, keep the truncated assistant message in context and
  // inject a continuation prompt so the model resumes from the cut.
  if (assembled.finishReason === "length") {
    state.consecutiveEmptyCount = 0;
    if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
      state.maxOutputRecoveryCount++;
      return yield* continueWithTransientPrompt(
        state,
        input,
        "Output token limit hit. Resume directly - no apology, no recap of what you were doing. " +
          "Pick up mid-sentence if that is where the cut happened.",
        "max_output_recovery",
      );
    }
    // Exhausted — fall through to normal completion with whatever
    // text was produced so far.
    const status = createMaxOutputRecoveryExhaustedStatus({ attempts: state.maxOutputRecoveryCount });
    yield await emitStatus(input, status);
  }

  const largeFileDecision = state.largeFileRepair.onNoToolCalls();
  if (largeFileDecision) {
    const continued = await deps.continueWithSyntheticPrompt(state, input, largeFileDecision);
    if (continued.type === "completed") {
      if (continued.status) {
        yield await emitStatus(input, continued.status);
      }
      return yield* terminateTurn(deps, input, state, continued.result, { emitFailureEvent: true });
    }
    yield continued.event;
    return { kind: "continue" };
  }

  if (!assembled.hasPartialTextToolCall && assembled.hasUnparsedTextToolCall) {
    if (!state.hasAttemptedToolCallRetry) {
      state.hasAttemptedToolCallRetry = true;
      return yield* continueWithTransientPrompt(
        state,
        input,
        getSelfCorrectPrompt(deps.config.toolCallFormat ?? assembled.textToolCallFormat, assistantText),
        "unparsed_tool_call_retry",
      );
    }

    yield {
      type: "warning",
      sessionId: input.sessionId,
      turnId: input.turnId,
      code: "unparsed_tool_call",
      message: "Model attempted to call a tool but the output could not be parsed. The response may be incomplete.",
      metadata: {
        detectedFormat: assembled.textToolCallFormat ?? detectFormatByText(assistantText)?.id,
      },
    };
  }

  const stopHooks = await deps.dispatchLifecycle(input, "Stop", {
    stopHookActive: false,
    lastAssistantMessage: textFromMessage(assistantMessage),
  });
  yield { type: "stop_requested", sessionId: input.sessionId, turnId: input.turnId };
  state.messages.push(...stopHooks.messages);
  const stopBlock = findLifecycleBlock(stopHooks);
  if (stopBlock) {
    const result = createTurnResult(input, {
      type: "error",
      stopReason: "tool_error",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: state.turnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
      structuredOutput: state.structuredOutput,
      errors: [agentError("agent_unsupported_feature", stopBlock.reason)],
    });
    yield await emitStatus(
      input,
      createLifecycleBlockedStatus({
        error: result.errors![0]!,
        stage: "stop",
      }),
    );
    return yield* terminateTurn(deps, input, state, result, { emitFailureEvent: true });
  }
  // 声称-行动守卫（W3）：收尾文本含验证类声称但本 run 无支撑工具成功执行
  // 时，强制一轮纠正（模型补做动作或改口）；每 run 至多一次，误报代价仅
  // 一轮。仅在 agent 模式启用——plan/ask 模式工具受限，模型只能改口，
  // 纠正提示要求补做动作无意义。默认关闭，SATI_CLAIM_GUARD=1 开启。
  if (
    deps.config.claimGuard === true &&
    (input.runMode === undefined || input.runMode === "agent") &&
    !state.hasAttemptedClaimGuardRetry
  ) {
    const verdict = evaluateClaimGuard(assistantText, state.succeededToolNames);
    if (verdict.kind === "correction") {
      state.hasAttemptedClaimGuardRetry = true;
      return yield* continueWithTransientPrompt(state, input, verdict.prompt, "claim_guard_retry");
    }
  }
  // 元认知控制：shaky 自评不静默收尾——带诊断重试一次（非空白重试）。
  // 仅 shaky 触发控制退出（见 spec）；strong/thin 被识别但不改行为——一个
  // 不改变下一步的自评只是评论，不是监控动作。
  if (deps.config.metacognitiveControl === true && !state.hasAttemptedMetacognitiveRetry) {
    const estimate = parseSelfEstimate(assistantText);
    if (estimate.tag === "shaky") {
      state.hasAttemptedMetacognitiveRetry = true;
      return yield* continueWithTransientPrompt(
        state,
        input,
        buildMetacognitiveRetryPrompt(estimate.diagnosis),
        "metacognitive_retry",
        "metacognitive_retry",
      );
    }
  }

  const finishStatus = createFinishReasonStatus(assembled.finishReason, assistantText);
  if (finishStatus) {
    yield await emitStatus(input, finishStatus);
  }

  const result = createTurnResult(input, {
    type: "success",
    stopReason: "completed",
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    turns: state.turnCount,
    startedAt: state.startedAt,
    finalMessage: state.finalMessage,
    structuredOutput: state.structuredOutput,
  });
  return yield* terminateTurn(deps, input, state, result);
}
