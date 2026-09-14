import {
  applyModelEventToAssembler,
  createModelMessageAssemblerState,
  type AssembledAssistantMessage,
  type CanonicalToolCall,
  type CanonicalMessage,
  ModelProviderError,
  type CanonicalModelRequest,
  getSelfCorrectPrompt,
  detectFormatByText,
  textFromMessage,
} from "../../model/index.js";
import type { SatiToolResult } from "../../tool/protocol/result.js";
import type { SatiReadFileStateMap, SatiWriteSnapshotMap } from "../../tool/protocol/types.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import { createLogger } from "../../telemetry/index.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { TokenBudgetSnapshot } from "../../context/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";
import type { RouterDecision } from "../../router/index.js";
import type { AgentRunMode, AgentLoopInput } from "../protocol/input.js";
import { buildMetacognitiveRetryPrompt, parseSelfEstimate } from "./metacognitiveControl.js";
import { evaluateClaimGuard } from "./claimGuard.js";
import { buildRequestHeaderSnapshot, verifyRequestHeaderSnapshot } from "./requestInvariant.js";
import { projectToolResults } from "./projectToolResults.js";
import type { LargeFileRepairDecision } from "./LargeFileRepair.js";
import { MAX_OUTPUT_RECOVERY_LIMIT, MAX_SAME_INVALID_FINGERPRINT, TurnRuntimeState } from "./turnRuntimeState.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import {
  buildRepeatReminderMessage,
  REPEAT_REMINDER_THRESHOLD,
  RepeatTracker,
  toolCallKey,
} from "./repeatToolReminder.js";
import { buildSteerMessage, steerPreview } from "./steer.js";
import { recordToolResults } from "./doomLoopIntegration.js";
import {
  bindSupplementalMessagesToToolCalls,
  cloneReadFileStateMap,
  cloneWriteSnapshotMap,
  createLifecycleDispatcher,
  findLifecycleBlock,
  findToolLifecycleBlock,
  mergeUserRules,
  readRequestedMode,
  type LifecycleDispatcher,
} from "./misc.js";
import { stripTrailingErrorPair } from "./messages.js";
import {
  annotateRepeatedToolFailures,
  buildInvalidFingerprint,
  collectPermissionDenials,
  detectRepeatedToolFailure,
} from "./toolFailure.js";
import {
  createEmptyResponseStatus,
  createFinishReasonStatus,
  createLifecycleBlockedStatus,
  createMaxOutputRecoveryExhaustedStatus,
  createMaxTurnsStatus,
  createModelRequestFailedStatus,
  createStructuredOutputCompletedStatus,
  createToolErrorLoopStatus,
} from "./modelErrors.js";
import { TokenCapManager } from "./tokenCapManager.js";
import { ToolContextFactory } from "./toolContext.js";
import { SubagentExecutor } from "./subagentExecutor.js";
import {
  abortTurn,
  buildTurnResult,
  captureAbortedPartial,
  createAbortStatus,
  emitStatus,
  terminateTurn,
  type TurnExitDeps,
  type TurnResultOptions,
  type TurnStepContinue,
  type TurnStepReturn,
} from "./turnExit.js";
import { continueWithTransientPrompt, recoverFromEmptyResponse } from "./recoveryStrategies.js";
import { recoverFromModelError, type ModelErrorRecoveryDeps } from "./modelErrorRecovery.js";
import { assembleAndRecover, type ResponseAssemblyDeps, type SyntheticPromptOutcome } from "./responseAssembly.js";
import { runAutoCompact } from "./compactionExecutor.js";
import { createBudgetEvaluator, createModelRequest, type ModelRequestDeps } from "./modelRequest.js";

const agentLogger = createLogger("agent");
const CIRCUIT_BREAKER_GRACE_PROMPT = [
  "Your last several tool calls all failed input validation with the same error.",
  "This may indicate a tool-side issue rather than a problem with your approach.",
  "Options: (1) try a different tool or different parameters,",
  "(2) explain the situation in text without calling tools,",
  "(3) if you believe the tool should work, try once more with corrected input.",
].join(" ");

export type { AgentLoopInput } from "../protocol/input.js";

export type AgentLoopRunResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export type AgentLoopSeedState = {
  readFileState?: SatiReadFileStateMap;
  writeSnapshots?: SatiWriteSnapshotMap;
  allowedReadFiles?: string[];
};

type TurnGuardsResult = TurnStepContinue | TurnStepReturn;
type PrepareModelCallResult =
  | TurnStepReturn
  | {
      kind: "continue";
      request: CanonicalModelRequest;
      decision: RouterDecision;
      routedMaxOutputTokens: number | undefined;
    };
type StreamModelResponseResult =
  | TurnStepReturn
  | { kind: "continue"; assembler: ReturnType<typeof createModelMessageAssemblerState> };
type NoToolCallsResult = TurnStepContinue | TurnStepReturn;
type ExecuteToolCallsResult = TurnStepReturn | TurnStepContinue | { kind: "proceed"; pairedResults: SatiToolResult[] };
type CircuitBreakerResult = TurnStepContinue | TurnStepReturn;
type FinishTurnResult = TurnStepContinue | TurnStepReturn;

export class AgentLoop {
  private readonly readFileState: SatiReadFileStateMap;
  /** 阶段四 T6.2：连续重复工具调用追踪（软提醒用）。 */
  private readonly repeatTracker: RepeatTracker;
  private readonly writeSnapshots: SatiWriteSnapshotMap;
  private readonly allowedReadFiles: Set<string>;
  private readonly tokenCaps: TokenCapManager;
  private readonly dispatchLifecycle: LifecycleDispatcher;
  private readonly toolContextFactory: ToolContextFactory;
  private readonly subagentExecutor: SubagentExecutor;
  private readonly turnExit: TurnExitDeps;
  private readonly modelErrorRecovery: ModelErrorRecoveryDeps;
  private readonly responseAssembly: ResponseAssemblyDeps;
  private readonly modelRequest: ModelRequestDeps;

  constructor(
    private readonly config: AgentRuntimeConfig,
    private readonly dependencies: AgentRuntimeDependencies,
    seedState?: AgentLoopSeedState,
  ) {
    this.readFileState = cloneReadFileStateMap(seedState?.readFileState);
    this.writeSnapshots = cloneWriteSnapshotMap(seedState?.writeSnapshots);
    this.allowedReadFiles = new Set(seedState?.allowedReadFiles ?? []);
    this.repeatTracker = new RepeatTracker();
    this.tokenCaps = new TokenCapManager(config, dependencies);
    this.dispatchLifecycle = createLifecycleDispatcher(config, dependencies);
    this.toolContextFactory = new ToolContextFactory({
      config,
      dependencies,
      readFileState: this.readFileState,
      writeSnapshots: this.writeSnapshots,
      allowedReadFiles: this.allowedReadFiles,
      now: this.now,
      dispatchLifecycle: this.dispatchLifecycle,
    });
    this.turnExit = { tokenCaps: this.tokenCaps, contextRuntime: dependencies.context, now: this.now };
    this.modelErrorRecovery = {
      ...this.turnExit,
      jsonSelfCorrect: config.jsonSelfCorrect,
      missingToolResultRecoveryContext: () => this.missingToolResultRecoveryContext(),
      dispatchLifecycle: this.dispatchLifecycle,
      runAutoCompact: (state, input, options) => runAutoCompact(this.dependencies.context, state, input, options),
    };
    this.modelRequest = { config, dependencies, dispatchLifecycle: this.dispatchLifecycle };
    this.responseAssembly = {
      ...this.turnExit,
      doomLoop: dependencies.doomLoop,
      eventEmitter: dependencies.eventEmitter,
      listToolNames: () => this.dependencies.tools.registry.list().map(tool => tool.name),
      toolAliases: config.toolAliases,
      continueWithSyntheticPrompt: (state, input, decision, options) =>
        this.continueWithSyntheticPrompt(state, input, decision, options),
    };
    this.subagentExecutor = new SubagentExecutor({
      now: this.now,
      drainEvents: dependencies.drainEvents,
      scheduler: dependencies.tools.scheduler,
    });
  }

  snapshotFileState(): AgentLoopSeedState {
    return {
      readFileState: cloneReadFileStateMap(this.readFileState),
      writeSnapshots: cloneWriteSnapshotMap(this.writeSnapshots),
      allowedReadFiles: [...this.allowedReadFiles],
    };
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.tokenCaps.clearTurnScopedTokenCaps();
    this.applyRunModeOverride(input.runMode);
    this.applyPermissionOverrides(input.permissionMode, input.permissionRules, input.basePermissionMode);
    for (const filePath of input.allowedReadFiles ?? []) {
      this.allowedReadFiles.add(filePath);
    }
    const state = new TurnRuntimeState(input, this.dependencies, this.now().toISOString());
    this.dependencies.doomLoop?.reset(state.turnCount);

    while (true) {
      const guards = yield* this.runTurnGuards(state, input);
      if (guards.kind === "return") return { result: guards.result, messages: guards.messages };

      yield* this.applySteeredMessages(state, input);

      const prepared = yield* this.prepareModelCall(state, input);
      if (prepared.kind === "return") return { result: prepared.result, messages: prepared.messages };

      const streamed = yield* this.streamModelResponse(state, input, prepared.request, prepared.decision);
      if (streamed.kind === "return") return { result: streamed.result, messages: streamed.messages };

      const assembled = yield* assembleAndRecover(
        this.responseAssembly,
        state,
        input,
        prepared.request,
        prepared.decision,
        prepared.routedMaxOutputTokens,
        streamed.assembler,
      );
      if (assembled.kind === "return") return { result: assembled.result, messages: assembled.messages };
      if (assembled.kind === "continue") continue;

      if (assembled.assembled.error) {
        const recovered = yield* recoverFromModelError(
          this.modelErrorRecovery,
          state,
          input,
          prepared.request,
          prepared.decision,
          assembled.assembled,
          assembled.toolCalls,
          prepared.routedMaxOutputTokens,
        );
        if (recovered.kind === "return") return { result: recovered.result, messages: recovered.messages };
        continue;
      }

      if (assembled.toolCalls.length === 0) {
        const finished = yield* this.handleNoToolCalls(
          state,
          input,
          prepared.request,
          prepared.decision,
          assembled.assembled,
          assembled.assistantMessage,
          assembled.toolCalls,
          prepared.routedMaxOutputTokens,
        );
        if (finished.kind === "return") return { result: finished.result, messages: finished.messages };
        continue;
      }

      const executed = yield* this.executeToolCalls(state, input, assembled.toolCalls, assembled.assembled);
      if (executed.kind === "return") return { result: executed.result, messages: executed.messages };
      if (executed.kind === "continue") continue;

      const breaker = yield* this.handleCircuitBreaker(state, input, executed.pairedResults);
      if (breaker.kind === "return") return { result: breaker.result, messages: breaker.messages };

      const next = yield* this.finishTurn(state, input);
      if (next.kind === "return") return { result: next.result, messages: next.messages };
    }
  }

  private async *runTurnGuards(
    state: TurnRuntimeState,
    input: AgentLoopInput,
  ): AsyncGenerator<AgentEvent, TurnGuardsResult, unknown> {
    if (input.abortSignal?.aborted) {
      return yield* abortTurn(this.turnExit, input, state);
    }

    if (state.doomLoopFatalReason !== undefined) {
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "model_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        errors: [agentError("agent_doomloop", state.doomLoopFatalReason)],
      });
      return yield* terminateTurn(this.turnExit, input, state, result, { emitFailureEvent: true });
    }

    // PreStep 扩展点：turn 开始、模型请求组装前（对应 dsh pre-step 瀑布）。
    // 钩子返回的 messages 追加到本轮模型可见消息（改写）；blockingErrors 中
    // 的 block 效果终止 turn（拒绝）。无钩子注册时 dispatch 返回空结果，零开销。
    const preStep = await this.dispatchLifecycle(input, "PreStep", {
      messages: state.messages,
      turnCount: state.turnCount,
    });
    if (preStep.messages.length > 0) {
      state.messages.push(...preStep.messages);
    }
    const preStepBlock = findLifecycleBlock(preStep);
    if (preStepBlock) {
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "tool_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [agentError("agent_unsupported_feature", preStepBlock.reason)],
      });
      yield await emitStatus(
        input,
        createLifecycleBlockedStatus({
          error: result.errors![0]!,
          stage: "pre_step",
        }),
      );
      return yield* terminateTurn(this.turnExit, input, state, result, { emitFailureEvent: true });
    }

    return { kind: "continue" };
  }

  /**
   * Mid-turn steering（协议 1.6）：模型调用边界 drain 插话邮箱。每个排队项
   * 构造为用户消息先落库（onDurableMessage，fail 即不注入——持久边界优先）
   * 再追加到消息序列尾部，并广播 steer_applied。未接线或空队列时零开销。
   */
  private async *applySteeredMessages(
    state: TurnRuntimeState,
    input: AgentLoopInput,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const source = this.dependencies.steerSource;
    if (!source) return;
    const items = source.drain();
    if (items.length === 0) return;
    for (const item of items) {
      const message = buildSteerMessage(item);
      await input.onDurableMessage?.(message);
      state.messages = [...state.messages, message];
      yield {
        type: "steer_applied",
        sessionId: input.sessionId,
        turnId: input.turnId,
        steerId: item.steerId,
        preview: steerPreview(item.text),
      };
    }
  }

  private async *prepareModelCall(
    state: TurnRuntimeState,
    input: AgentLoopInput,
  ): AsyncGenerator<AgentEvent, PrepareModelCallResult, unknown> {
    let pendingContextBudget: TokenBudgetSnapshot | undefined;
    const ctx = this.dependencies.context;
    const preRoutingMaxContextTokens = this.tokenCaps.currentMaxContextTokens(this.config.provider, this.config.model);
    if (ctx?.tryAutoCompact) {
      const reservedOutputTokens = this.tokenCaps.getReservedOutputTokens();
      const compact = yield* runAutoCompact(this.dependencies.context, state, input, {
        stage: "pre-routing",
        reservedOutputTokens,
        budgetEvaluator: createBudgetEvaluator(this.modelRequest, input, {
          maxContextTokens: preRoutingMaxContextTokens,
          reservedOutputTokens,
        }),
      });
      pendingContextBudget = compact.snapshot;
      yield* this.subagentExecutor.drainEventBuffer();
    }

    let request = await createModelRequest(this.modelRequest, state.messages, input, { state });
    if (input.abortSignal?.aborted) {
      return yield* abortTurn(this.turnExit, input, state);
    }
    this.dispatchLifecycle(input, "PreModelRequest", {
      provider: request.provider,
      model: request.model,
    }).catch(error => agentLogger.warn("PreModelRequest lifecycle dispatch failed:", error));
    yield {
      type: "model_request_started",
      sessionId: input.sessionId,
      turnId: input.turnId,
      model: request.model,
      provider: request.provider,
    };

    // Split decide + execute so we can insert a post-routing compact pass
    // when the routed model's context window differs from the agent's
    // default model (the window used by the first tryAutoCompact above).
    let decision: RouterDecision;
    try {
      decision = await this.dependencies.router.decide({
        request,
        sessionId: input.sessionId,
        isMainAgent: !this.config.isSubagent,
        // 取消回合时同步中止在途的路由判官：否则判官要跑满超时才返回，为一个
        // 已取消的回合发出降级事件并白白占用一次 judge 调用。
        abortSignal: input.abortSignal,
        metadata: state.stickyInfo
          ? {
              previousTier: state.previousTier,
              previousProvider: state.stickyInfo.previousProvider,
              previousModel: state.stickyInfo.previousModel,
            }
          : state.previousTier
            ? { previousTier: state.previousTier }
            : undefined,
      });
    } catch (error) {
      // decide 会把中止原因原样抛出（RouterRuntime 的 abort 重抛语义）；按取消
      // 收尾，而不是让取消被记成一次路由失败。
      if (input.abortSignal?.aborted) {
        return yield* abortTurn(this.turnExit, input, state);
      }
      throw error;
    }
    const routedLimits = this.tokenCaps.getModelTokenLimits(decision.provider, decision.model);
    const routedMaxOutputTokens = routedLimits?.maxOutputTokens;

    let emittedContextBudget = false;
    if (ctx?.tryAutoCompact) {
      const routedMaxCtx = this.tokenCaps.currentMaxContextTokens(decision.provider, decision.model);
      const currentBudgetMaxCtx = preRoutingMaxContextTokens;
      if (routedMaxCtx !== undefined && routedMaxCtx !== currentBudgetMaxCtx) {
        const reservedOutputTokens = this.tokenCaps.getReservedOutputTokens(decision.provider, decision.model);
        const recompact = yield* runAutoCompact(this.dependencies.context, state, input, {
          stage: "post-routing",
          maxContextTokens: routedMaxCtx,
          reservedOutputTokens,
          budgetEvaluator: createBudgetEvaluator(this.modelRequest, input, {
            decision,
            baseRequest: request,
            maxContextTokens: routedMaxCtx,
            reservedOutputTokens,
          }),
        });
        if (recompact.compacted) {
          request = await createModelRequest(this.modelRequest, state.messages, input, { state });
          request = this.tokenCaps.applyTokenCapsToRequest(request, decision.provider, decision.model);
        }
        if (recompact.snapshot !== undefined) {
          yield {
            type: "context_budget",
            sessionId: input.sessionId,
            turnId: input.turnId,
            snapshot: recompact.snapshot,
          };
          emittedContextBudget = true;
        }
      }
    }
    request = this.tokenCaps.applyTokenCapsToRequest(request, decision.provider, decision.model);
    this.tokenCaps.clearAttemptOutputTokenCap(decision.provider, decision.model);
    if (pendingContextBudget && !emittedContextBudget) {
      yield {
        type: "context_budget",
        sessionId: input.sessionId,
        turnId: input.turnId,
        snapshot: pendingContextBudget,
      };
    }

    return { kind: "continue", request, decision, routedMaxOutputTokens };
  }

  private async *streamModelResponse(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    request: CanonicalModelRequest,
    decision: RouterDecision,
  ): AsyncGenerator<AgentEvent, StreamModelResponseResult, unknown> {
    // 阶段四 T2：发送前落 request_header 快照（log-only，供审计与重建对拍）。
    // 写入失败即中止本步（fail-closed：无法记录请求头就不发送）。
    const requestHeader = buildRequestHeaderSnapshot(request, decision);
    await input.onRequestHeader?.(requestHeader);
    if (process.env.SATI_VERIFY_REQUEST_RECONSTRUCTION === "1") {
      verifyRequestHeaderSnapshot(requestHeader, request, decision);
    }
    const assembler = createModelMessageAssemblerState();
    try {
      for await (const event of this.dependencies.router.execute(decision, request, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        projectPath: this.config.cwd,
        abortSignal: input.abortSignal,
      })) {
        yield { type: "model_event", sessionId: input.sessionId, turnId: input.turnId, event };
        applyModelEventToAssembler(assembler, event);
        if (event.type === "error") {
          break;
        }
      }
      if (!state.stickyInfo?.orchestrating) state.previousTier = undefined;
    } catch (error) {
      if (input.abortSignal?.aborted) {
        yield* captureAbortedPartial(state, input, assembler);
        return yield* abortTurn(this.turnExit, input, state);
      }
      const modelError = error instanceof ModelProviderError ? error.error : undefined;
      const stopFailureMsg = modelError?.message ?? (error instanceof Error ? error.message : String(error));
      await this.dispatchLifecycle(input, "StopFailure", { error: stopFailureMsg });
      yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: stopFailureMsg };
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "model_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        errors: [agentError("agent_model_error", stopFailureMsg, modelError, modelError?.userHint)],
      });
      const abortStatus = createAbortStatus(input);
      if (abortStatus) {
        yield await emitStatus(input, abortStatus);
      } else {
        yield await emitStatus(
          input,
          createModelRequestFailedStatus({
            error: result.errors![0]!,
            modelError,
          }),
        );
      }
      return yield* terminateTurn(this.turnExit, input, state, result, { emitFailureEvent: true });
    }

    if (input.abortSignal?.aborted) {
      yield* captureAbortedPartial(state, input, assembler);
      return yield* abortTurn(this.turnExit, input, state);
    }

    return { kind: "continue", assembler };
  }

  private async *handleNoToolCalls(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    request: CanonicalModelRequest,
    decision: RouterDecision,
    assembled: AssembledAssistantMessage,
    assistantMessage: CanonicalMessage,
    toolCalls: CanonicalToolCall[],
    routedMaxOutputTokens: number | undefined,
  ): AsyncGenerator<AgentEvent, NoToolCallsResult, unknown> {
    if (toolCalls.length === 0) {
      const assistantText = textFromMessage(assistantMessage);

      // Global guard: empty assistant response (no text, no tool calls).
      // The model produced nothing visible — typically because extended
      // thinking consumed the entire output budget.
      if (assistantText.length === 0) {
        state.messages.pop();

        const recovery = yield* recoverFromEmptyResponse(
          this.turnExit,
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
        const continued = await this.continueWithSyntheticPrompt(state, input, largeFileDecision);
        if (continued.type === "completed") {
          if (continued.status) {
            yield await emitStatus(input, continued.status);
          }
          return yield* terminateTurn(this.turnExit, input, state, continued.result, { emitFailureEvent: true });
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
            getSelfCorrectPrompt(this.config.toolCallFormat ?? assembled.textToolCallFormat, assistantText),
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

      const stopHooks = await this.dispatchLifecycle(input, "Stop", {
        stopHookActive: false,
        lastAssistantMessage: textFromMessage(assistantMessage),
      });
      yield { type: "stop_requested", sessionId: input.sessionId, turnId: input.turnId };
      state.messages.push(...stopHooks.messages);
      const stopBlock = findLifecycleBlock(stopHooks);
      if (stopBlock) {
        const result = this.createTurnResult(input, {
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
        return yield* terminateTurn(this.turnExit, input, state, result, { emitFailureEvent: true });
      }
      // 声称-行动守卫（W3）：收尾文本含验证类声称但本 run 无支撑工具成功执行
      // 时，强制一轮纠正（模型补做动作或改口）；每 run 至多一次，误报代价仅
      // 一轮。仅在 agent 模式启用——plan/ask 模式工具受限，模型只能改口，
      // 纠正提示要求补做动作无意义。默认关闭，SATI_CLAIM_GUARD=1 开启。
      if (
        this.config.claimGuard === true &&
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
      if (this.config.metacognitiveControl === true && !state.hasAttemptedMetacognitiveRetry) {
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

      const result = this.createTurnResult(input, {
        type: "success",
        stopReason: "completed",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
      });
      return yield* terminateTurn(this.turnExit, input, state, result);
    }

    return { kind: "continue" };
  }

  private async *executeToolCalls(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    toolCalls: CanonicalToolCall[],
    assembled: AssembledAssistantMessage,
  ): AsyncGenerator<AgentEvent, ExecuteToolCallsResult, unknown> {
    yield { type: "tool_calls_detected", sessionId: input.sessionId, turnId: input.turnId, calls: toolCalls };
    if (input.abortSignal?.aborted) {
      return yield* abortTurn(this.turnExit, input, state);
    }

    // 阶段四 T4.1：durable 边界检查点——工具副作用（写文件/外呼/子代理）执行
    // 前强制刷新转录落盘。失败即中止本步（fail-closed：无法保证持久边界就不
    // 发生副作用）。调用方未接 flushCheckpoint 时是 no-op。
    await input.onFlushCheckpoint?.();

    let results: SatiToolResult[];
    try {
      const toolContext = this.toolContextFactory.createToolContext(input);
      if (assembled.finishReason === "length" || assembled.hasRepairedToolCalls) {
        toolContext.outputTruncated = true;
      }
      results = yield* this.subagentExecutor.executeToolsWithEventPump(toolCalls, toolContext, input);
    } catch (error) {
      results = toolCalls.map(call =>
        createMissingToolResult(
          call,
          this.now,
          error instanceof Error ? error.message : String(error),
          this.missingToolResultRecoveryContext(),
        ),
      );
    }
    if (input.abortSignal?.aborted) {
      return yield* abortTurn(this.turnExit, input, state);
    }
    yield* this.subagentExecutor.drainEventBuffer();

    // 阶段四 T6.2：连续重复软提醒——达到阈值（默认 3 次）后向下一轮请求
    // 注入一次 transient advisory（不拦截；doomLoop 仍是硬断开）。
    for (const call of toolCalls) {
      const count = this.repeatTracker.record(toolCallKey(call.name, call.input));
      if (count === REPEAT_REMINDER_THRESHOLD) {
        state.messages = [...state.messages, buildRepeatReminderMessage(call.name, count)];
      }
    }

    let pairedResults = ensureToolResultPairing(
      toolCalls,
      results,
      this.now,
      "Tool execution did not produce a result.",
      this.missingToolResultRecoveryContext(),
    );
    const repeatedFailure = detectRepeatedToolFailure(pairedResults, state.lastToolFailureFingerprint);
    pairedResults = annotateRepeatedToolFailures(pairedResults, repeatedFailure.repeatedKeys);
    state.lastToolFailureFingerprint = repeatedFailure.currentFingerprint;
    const toolFatalReason = recordToolResults(
      this.dependencies.doomLoop,
      toolCalls,
      pairedResults,
      input,
      this.dependencies.eventEmitter,
    );
    if (toolFatalReason) state.doomLoopFatalReason = toolFatalReason;
    const toolResultRepair = state.largeFileRepair.analyzeToolResults(pairedResults, {
      outputTruncated: assembled.finishReason === "length" || assembled.hasRepairedToolCalls === true,
      repairedToolCalls: assembled.hasRepairedToolCalls === true,
      finishReason: assembled.finishReason,
    });
    state.permissionDenials = [...state.permissionDenials, ...collectPermissionDenials(pairedResults)];
    for (const result of pairedResults) {
      // 声称-行动守卫：累积本 run 内成功执行的工具名（供 claimGuard 校验支撑）。
      if (result.type === "success") {
        state.succeededToolNames.push(result.toolName);
      }
      if (result.type === "success" && result.metadata?.structuredOutput) {
        state.structuredOutput = result.data;
      }
      const requestedMode = readRequestedMode(result.type === "success" ? result.data : undefined);
      if (requestedMode) {
        let effectiveMode = requestedMode;

        if (requestedMode === "plan" && this.config.permissionMode !== "plan") {
          this.config.permissionModeBeforePlan = this.config.permissionMode;
        } else if (this.config.permissionMode === "plan" && requestedMode !== "plan") {
          if (this.config.permissionModeBeforePlan) {
            effectiveMode = this.config.permissionModeBeforePlan;
            this.config.permissionModeBeforePlan = undefined;
          }
        }

        this.config.permissionMode = effectiveMode;
        this.config.permissionContext.mode = effectiveMode;
        yield {
          type: "mode_change_requested",
          sessionId: input.sessionId,
          turnId: input.turnId,
          mode: effectiveMode,
        };
      }
      yield { type: "tool_result", sessionId: input.sessionId, turnId: input.turnId, result };
    }

    const projected = projectToolResults(pairedResults);
    // Route the freshly projected tool_result message through the context
    // runtime so large payloads land on disk via `ToolResultBudget`. When
    // the runtime doesn't implement `applyToolResults` (e.g. NullContext),
    // we simply append the raw projection (legacy behaviour).
    const [toolResultMsg, ...supplementalMsgs] = projected;
    const supplementalInputs = bindSupplementalMessagesToToolCalls(pairedResults, supplementalMsgs);
    let appendedMessages: CanonicalMessage[] = projected;
    const ctxApply = this.dependencies.context?.applyToolResults;
    if (ctxApply) {
      try {
        const applied = await ctxApply.call(this.dependencies.context, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolResultMessage: toolResultMsg,
          supplementalMessages: supplementalInputs,
          messages: state.messages,
        });
        state.messages = applied.messages;
        appendedMessages = applied.appendedMessages ?? projected;
      } catch {
        // applyToolResults 失败（如 spill 落盘错误）：回退原始投影，保证工具结果不丢。
        state.messages.push(...projected);
      }
    } else {
      state.messages.push(...projected);
    }
    for (const appended of appendedMessages) {
      yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: appended };
      await input.onDurableMessage?.(appended);
    }

    if (toolResultRepair) {
      const continued = await this.continueWithSyntheticPrompt(state, input, toolResultRepair);
      if (continued.type === "completed") {
        if (continued.status) {
          yield await emitStatus(input, continued.status);
        }
        return yield* terminateTurn(this.turnExit, input, state, continued.result, { emitFailureEvent: true });
      }
      yield continued.event;
      return { kind: "continue" };
    }

    const lifecycleBlock = findToolLifecycleBlock(pairedResults);
    if (lifecycleBlock) {
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "tool_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [agentError("agent_unsupported_feature", lifecycleBlock.reason)],
      });
      yield await emitStatus(
        input,
        createLifecycleBlockedStatus({
          error: result.errors![0]!,
          stage: "tool_lifecycle",
        }),
      );
      return yield* terminateTurn(this.turnExit, input, state, result, { emitFailureEvent: true });
    }

    // Circuit breaker: detect turns where ALL tool calls returned
    // invalid_tool_input. Uses fingerprint-based detection (toolName +
    // errorMessage), and injects one grace prompt before final termination.
    // When LargeFileRepair is actively managing recovery, defer to its own
    // attempt limits instead of terminating here.
    return { kind: "proceed", pairedResults };
  }

  private async *handleCircuitBreaker(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    pairedResults: SatiToolResult[],
  ): AsyncGenerator<AgentEvent, CircuitBreakerResult, unknown> {
    const allInvalid =
      pairedResults.length > 0 && pairedResults.every(r => r.type === "error" && r.error.code === "invalid_tool_input");
    if (allInvalid && state.largeFileRepair.hasPendingRepair) {
      const fallbackRepair = state.largeFileRepair.onInvalidToolInput();
      if (fallbackRepair) {
        const continued = await this.continueWithSyntheticPrompt(state, input, fallbackRepair);
        if (continued.type === "completed") {
          if (continued.status) {
            yield await emitStatus(input, continued.status);
          }
          return yield* terminateTurn(this.turnExit, input, state, continued.result, { emitFailureEvent: true });
        }
        yield continued.event;
        return { kind: "continue" };
      }
    }
    if (allInvalid) {
      const fingerprint = buildInvalidFingerprint(pairedResults);
      if (fingerprint === state.lastInvalidFingerprint) {
        state.sameInvalidFingerprintCount++;
      } else {
        state.sameInvalidFingerprintCount = 1;
        state.lastInvalidFingerprint = fingerprint;
        state.hasUsedInvalidGracePeriod = false;
      }

      if (state.sameInvalidFingerprintCount >= MAX_SAME_INVALID_FINGERPRINT) {
        if (!state.hasUsedInvalidGracePeriod) {
          state.hasUsedInvalidGracePeriod = true;
          return yield* continueWithTransientPrompt(
            state,
            input,
            CIRCUIT_BREAKER_GRACE_PROMPT,
            "circuit_breaker_grace",
          );
        }

        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "tool_error",
          usage: state.usage,
          permissionDenials: state.permissionDenials,
          turns: state.turnCount,
          startedAt: state.startedAt,
          finalMessage: state.finalMessage,
          structuredOutput: state.structuredOutput,
          errors: [
            agentError(
              "agent_tool_error_loop",
              `Terminated: ${state.sameInvalidFingerprintCount} consecutive turns with identical tool input validation failures (same tool + same error). The model appears stuck in a loop.`,
              undefined,
              "The model is repeatedly producing invalid tool calls. Consider switching to a more capable model via settings.",
            ),
          ],
        });
        yield await emitStatus(
          input,
          createToolErrorLoopStatus({
            error: result.errors![0]!,
            repeatedFailures: state.sameInvalidFingerprintCount,
          }),
        );
        return yield* terminateTurn(this.turnExit, input, state, result, { emitFailureEvent: true });
      }
    } else {
      state.sameInvalidFingerprintCount = 0;
      state.lastInvalidFingerprint = undefined;
      state.hasUsedInvalidGracePeriod = false;
      if (!pairedResults.some(r => r.type === "error")) {
        state.lastToolFailureFingerprint = undefined;
      }
      state.maxOutputRecoveryCount = 0;
      state.consecutiveEmptyCount = 0;
      state.hasAttemptedOutputRetry = false;
      state.hasAttemptedEmptyRetry = false;
      state.hasAttemptedToolCallRetry = false;
    }

    return { kind: "continue" };
  }

  private async *finishTurn(
    state: TurnRuntimeState,
    input: AgentLoopInput,
  ): AsyncGenerator<AgentEvent, FinishTurnResult, unknown> {
    if (this.config.stopOnStructuredOutput && state.structuredOutput !== undefined) {
      const result = this.createTurnResult(input, {
        type: "success",
        stopReason: "completed",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
      });
      const status = createStructuredOutputCompletedStatus();
      yield await emitStatus(input, status);
      return yield* terminateTurn(this.turnExit, input, state, result);
    }

    const nextTurnCount = state.turnCount + 1;
    if (input.maxTurns && nextTurnCount > input.maxTurns) {
      const maxTurnsError = agentError(
        "agent_max_turns_reached",
        `Reached maximum number of turns (${input.maxTurns}).`,
        undefined,
        "Max turn limit reached. Increase maxTurns in config or break the task into smaller steps.",
      );
      const result = this.createTurnResult(input, {
        type: "max_turns",
        stopReason: "max_turns",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: nextTurnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [maxTurnsError],
      });
      const status = createMaxTurnsStatus({ maxTurns: input.maxTurns, error: maxTurnsError });
      yield await emitStatus(input, status);
      return yield* terminateTurn(this.turnExit, input, state, result, { emitFailureEvent: true });
    }

    state.turnCount = nextTurnCount;
    yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "next_turn" };
    return { kind: "continue" };
  }

  private missingToolResultRecoveryContext(): { cwd: string; permissionMode: PermissionMode } {
    return {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
    };
  }

  private async continueWithSyntheticPrompt(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    decision: LargeFileRepairDecision,
    options: { stripCurrentAssistant?: boolean } = {},
  ): Promise<SyntheticPromptOutcome> {
    if (decision.type === "stop") {
      const error = agentError("agent_tool_error_loop", decision.reason);
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "tool_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [error],
      });
      return { type: "completed", result, status: createToolErrorLoopStatus({ error }) };
    }
    if (options.stripCurrentAssistant !== false) {
      if (decision.strip === "error_pair") {
        state.messages = stripTrailingErrorPair(state.messages);
      } else if (decision.strip === "assistant") {
        const last = state.messages[state.messages.length - 1];
        if (last?.role === "assistant") {
          state.messages = state.messages.slice(0, -1);
        }
      }
    }
    state.pushTransientSyntheticPrompt(decision.prompt, decision.purpose);
    if (
      this.config.maxOutputTokens !== undefined &&
      this.config.maxOutputTokens < state.largeFileRepair.recommendedMaxOutputTokens
    ) {
      this.config.maxOutputTokens = state.largeFileRepair.recommendedMaxOutputTokens;
    }
    return {
      type: "continue",
      event: {
        type: "turn_continued",
        sessionId: input.sessionId,
        turnId: input.turnId,
        reason: "model_error",
      },
    };
  }

  /** turn 结果构造（sessionId/turnId/completedAt 补齐），now 由本类依赖注入。 */
  private createTurnResult(input: AgentLoopInput, options: TurnResultOptions): AgentTurnResult {
    return buildTurnResult(input, options, this.now());
  }

  private applyPermissionOverrides(
    permissionMode?: PermissionMode,
    permissionRules?: Partial<PermissionRuleSet>,
    basePermissionMode?: PermissionMode,
  ): void {
    if (permissionMode) {
      if (permissionMode === "plan" && this.config.permissionMode !== "plan") {
        this.config.permissionModeBeforePlan = basePermissionMode ?? this.config.permissionMode;
      }
      this.config.permissionMode = permissionMode;
      this.config.permissionContext.mode = permissionMode;
    }
    if (!permissionRules) return;
    mergeUserRules(this.config.permissionContext.rules.allow, permissionRules.allow);
    mergeUserRules(this.config.permissionContext.rules.deny, permissionRules.deny);
    mergeUserRules(this.config.permissionContext.rules.ask, permissionRules.ask);
  }

  private applyRunModeOverride(runMode?: AgentRunMode): void {
    if (runMode) {
      this.config.runMode = runMode;
    } else {
      this.config.runMode ??= "agent";
    }
  }

  private readonly now = (): Date => this.dependencies.now?.() ?? new Date();
}
