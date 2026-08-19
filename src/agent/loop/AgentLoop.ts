import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  cloneMessages,
  createModelMessageAssemblerState,
  type AssembledAssistantMessage,
  type CanonicalToolCall,
  type CanonicalMessage,
  type CanonicalModelError,
  ModelProviderError,
  type CanonicalModelRequest,
  type CanonicalUsage,
  type CanonicalToolCallBlock,
  materializeMediaReferences,
  getSelfCorrectPrompt,
  detectFormatByText,
  textFromMessage,
} from "../../model/index.js";
import type { SatiReadFileStateMap, SatiToolResult, SatiWriteSnapshotMap } from "../../tool/index.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import { compressIndexRanges } from "../../context/compaction/CompactionEngine.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { AutoCompactResult, ContextRecoveryDecision, TokenBudgetSnapshot } from "../../context/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";
import type { RouterDecision } from "../../router/index.js";
import type { AgentControlBoundaryTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { requiresPromptCapability } from "../../tool/userInteractionConstraints.js";
import type { AgentRunMode, AgentLoopInput } from "../protocol/input.js";
import { repairToolName } from "../../model/streaming/repairToolName.js";
import { applyMethodologyAddendum, computeMethodologyAddendum } from "./methodologyInjection.js";
import { buildRequestHeaderSnapshot, verifyRequestHeaderSnapshot } from "./requestInvariant.js";
import { projectToolResults } from "./projectToolResults.js";
import { resolveOutputTokenRetryBump } from "./outputTokenRetry.js";
import type { LargeFileRepairDecision } from "./LargeFileRepair.js";
import {
  MAX_CONSECUTIVE_EMPTY,
  MAX_JSON_SELF_CORRECT_RETRIES,
  MAX_OUTPUT_RECOVERY_LIMIT,
  MAX_SAME_INVALID_FINGERPRINT,
  TurnRuntimeState,
} from "./turnRuntimeState.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import {
  buildRepeatReminderMessage,
  REPEAT_REMINDER_THRESHOLD,
  RepeatTracker,
  toolCallKey,
} from "./repeatToolReminder.js";
import { collectToolCalls } from "./collectToolCalls.js";
import { recordModelCall, recordToolResults } from "./doomLoopIntegration.js";
import {
  bindSupplementalMessagesToToolCalls,
  cloneReadFileStateMap,
  cloneWriteSnapshotMap,
  createLifecycleDispatcher,
  filterAskModeTools,
  findLifecycleBlock,
  findToolLifecycleBlock,
  mergeUsage,
  mergeUserRules,
  readRequestedMode,
  toolToCanonicalSchema,
  type LifecycleDispatcher,
} from "./misc.js";
import {
  addEmptyReasoningContentMarkers,
  appendPlanModeReminder,
  buildPartialTextToolCallRecoveryPrompt,
  isMissingReasoningContentError,
  markCompactReplacementMessages,
  normalizeMessagesForModelRequest,
  splitTransientPrompts,
  stripImagesFromMessages,
  stripTrailingErrorPair,
  truncateHeadKeepRatio,
} from "./messages.js";
import {
  annotateRepeatedToolFailures,
  buildInvalidFingerprint,
  collectPermissionDenials,
  detectRepeatedToolFailure,
} from "./toolFailure.js";
import {
  classifyModelError,
  clampOutputToModelCap,
  createEmptyResponseStatus,
  createFinishReasonStatus,
  createLifecycleBlockedStatus,
  createMaxOutputRecoveryExhaustedStatus,
  createMaxTurnsStatus,
  createModelRequestFailedStatus,
  createStructuredOutputCompletedStatus,
  createToolCallRecoveryExhaustedStatus,
  createToolErrorLoopStatus,
  createTurnAbortedStatus,
  modelErrorTarget,
  shouldSurfaceAbortStatus,
  stringifyAbortReason,
  tokensFromUsage,
  type AgentStatusMessage,
} from "./modelErrors.js";
import { TokenCapManager } from "./tokenCapManager.js";
import { ToolContextFactory } from "./toolContext.js";
import { SubagentExecutor } from "./subagentExecutor.js";

const EMPTY_LENGTH_OUTPUT_RETRY_FLOOR = 4_096;
const CIRCUIT_BREAKER_GRACE_PROMPT = [
  "Your last several tool calls all failed input validation with the same error.",
  "This may indicate a tool-side issue rather than a problem with your approach.",
  "Options: (1) try a different tool or different parameters,",
  "(2) explain the situation in text without calling tools,",
  "(3) if you believe the tool should work, try once more with corrected input.",
].join(" ");

function logAutoCompactFailure(stage: string, input: { sessionId: string; turnId: string }, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[agent:auto-compact] ${stage} failed sessionId=${input.sessionId} turnId=${input.turnId}: ${message}`);
}

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

/** run() 阶段方法的统一步进结果：continue 进入下一阶段/下一轮，return 终止 run，proceed 携带数据进入后续判断。 */
type TurnStepContinue = { kind: "continue" };
type TurnStepReturn = { kind: "return"; result: AgentTurnResult; messages: CanonicalMessage[] };
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
type AssembleAndRecoverResult =
  | TurnStepReturn
  | TurnStepContinue
  | {
      kind: "proceed";
      assembled: AssembledAssistantMessage;
      assistantMessage: CanonicalMessage;
      toolCalls: CanonicalToolCall[];
    };
type ModelErrorRecoveredResult = TurnStepContinue | TurnStepReturn;
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

      const prepared = yield* this.prepareModelCall(state, input);
      if (prepared.kind === "return") return { result: prepared.result, messages: prepared.messages };

      const streamed = yield* this.streamModelResponse(state, input, prepared.request, prepared.decision);
      if (streamed.kind === "return") return { result: streamed.result, messages: streamed.messages };

      const assembled = yield* this.assembleAndRecover(
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
        const recovered = yield* this.handleModelError(
          state,
          input,
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
      return yield* this.abortTurn(input, state);
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
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
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
      yield await this.emitStatus(
        input,
        createLifecycleBlockedStatus({
          error: result.errors![0]!,
          stage: "pre_step",
        }),
      );
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
    }

    return { kind: "continue" };
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
      const compact = yield* this.runAutoCompact(state, input, {
        stage: "pre-routing",
        reservedOutputTokens,
        budgetEvaluator: this.createBudgetEvaluator(input, {
          maxContextTokens: preRoutingMaxContextTokens,
          reservedOutputTokens,
        }),
      });
      pendingContextBudget = compact.snapshot;
      yield* this.subagentExecutor.drainEventBuffer();
    }

    let request = await this.createModelRequest(state.messages, input, { state });
    if (input.abortSignal?.aborted) {
      return yield* this.abortTurn(input, state);
    }
    this.dispatchLifecycle(input, "PreModelRequest", {
      provider: request.provider,
      model: request.model,
    }).catch(error => console.warn("[agent] PreModelRequest lifecycle dispatch failed:", error));
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
    const decision = await this.dependencies.router.decide({
      request,
      sessionId: input.sessionId,
      isMainAgent: !this.config.isSubagent,
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
    const routedLimits = this.tokenCaps.getModelTokenLimits(decision.provider, decision.model);
    const routedMaxOutputTokens = routedLimits?.maxOutputTokens;

    let emittedContextBudget = false;
    if (ctx?.tryAutoCompact) {
      const routedMaxCtx = this.tokenCaps.currentMaxContextTokens(decision.provider, decision.model);
      const currentBudgetMaxCtx = preRoutingMaxContextTokens;
      if (routedMaxCtx !== undefined && routedMaxCtx !== currentBudgetMaxCtx) {
        const reservedOutputTokens = this.tokenCaps.getReservedOutputTokens(decision.provider, decision.model);
        const recompact = yield* this.runAutoCompact(state, input, {
          stage: "post-routing",
          maxContextTokens: routedMaxCtx,
          reservedOutputTokens,
          budgetEvaluator: this.createBudgetEvaluator(input, {
            decision,
            baseRequest: request,
            maxContextTokens: routedMaxCtx,
            reservedOutputTokens,
          }),
        });
        if (recompact.compacted) {
          request = await this.createModelRequest(state.messages, input, { state });
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
        yield* this.captureAbortedPartial(state, input, assembler);
        return yield* this.abortTurn(input, state);
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
      const abortStatus = this.createAbortStatus(input);
      if (abortStatus) {
        yield await this.emitStatus(input, abortStatus);
      } else {
        yield await this.emitStatus(
          input,
          createModelRequestFailedStatus({
            error: result.errors![0]!,
            modelError,
          }),
        );
      }
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
    }

    if (input.abortSignal?.aborted) {
      yield* this.captureAbortedPartial(state, input, assembler);
      return yield* this.abortTurn(input, state);
    }

    return { kind: "continue", assembler };
  }

  private async *assembleAndRecover(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    request: CanonicalModelRequest,
    decision: RouterDecision,
    routedMaxOutputTokens: number | undefined,
    assembler: ReturnType<typeof createModelMessageAssemblerState>,
  ): AsyncGenerator<AgentEvent, AssembleAndRecoverResult, unknown> {
    const assembled = assembleAssistantMessage(assembler);
    state.usage = mergeUsage(state.usage, assembled.usage);
    state.lastModelUsage = assembled.usage;
    let assistantMessage = assembled.message;
    let toolCalls = collectToolCalls(assistantMessage);
    if (assembled.hasTextFallbackToolCalls) {
      const repaired = this.repairTextExtractedToolNames(assistantMessage, toolCalls);
      assistantMessage = repaired.message;
      toolCalls = repaired.toolCalls;
    }
    state.finalMessage = assistantMessage;
    state.expireConsumedTransientPrompts();
    const fatalReason = recordModelCall(
      this.dependencies.doomLoop,
      assistantMessage,
      input,
      this.dependencies.eventEmitter,
    );
    if (fatalReason) state.doomLoopFatalReason = fatalReason;

    if (assembled.hasPartialTextToolCall) {
      if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
        state.maxOutputRecoveryCount++;
        return yield* this.continueWithTransientPrompt(
          state,
          input,
          buildPartialTextToolCallRecoveryPrompt(assembled.partialTextToolCall),
          "max_output_recovery",
        );
      }

      const detail = assembled.partialTextToolCall
        ? `${assembled.partialTextToolCall.format}/${assembled.partialTextToolCall.reason}`
        : "unknown partial text tool-call";
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "model_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [
          agentError(
            "agent_model_error",
            `Partial text tool-call recovery exhausted after ${MAX_OUTPUT_RECOVERY_LIMIT} attempts (${detail}).`,
          ),
        ],
      });
      yield await this.emitStatus(
        input,
        createToolCallRecoveryExhaustedStatus({
          error: result.errors![0]!,
          attempts: state.maxOutputRecoveryCount,
          reason: detail,
        }),
      );
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
    }

    // When jsonrepair silently "fixed" truncated JSON and the response
    // was cut by max_tokens, the tool call arguments are likely incomplete
    // (e.g. half-written file content). Apply the same recovery as
    // max_output_reached: token doubling → continuation prompt → give up.
    //
    // This gate intentionally runs before durable assistant emission. The
    // recovered response should replace the dirty repaired/truncated message,
    // not leave an unmatched tool_call in the transcript.
    if (
      assembled.hasRepairedToolCalls &&
      (assembled.finishReason === "length" ||
        assembled.finishReason === "tool_call" ||
        assembled.finishReason === "stop")
    ) {
      console.warn(
        `[AgentLoop] Blocking ${toolCalls.length} repaired-but-truncated tool call(s) — entering max_output recovery`,
      );

      const largeFileDecision = state.largeFileRepair.recoverFromRepairedTruncation(toolCalls);
      if (largeFileDecision) {
        const continued = await this.continueWithSyntheticPrompt(state, input, largeFileDecision, {
          stripCurrentAssistant: false,
        });
        if (continued.type === "completed") {
          if (continued.status) {
            yield await this.emitStatus(input, continued.status);
          }
          return yield* this.terminateTurn(input, state, continued.result, { emitFailureEvent: true });
        }
        yield continued.event;
        return { kind: "continue" };
      }

      // Phase A: token doubling (if not yet attempted)
      if (!state.hasAttemptedOutputRetry) {
        state.hasAttemptedOutputRetry = true;
        const nextMaxOutputTokens = resolveOutputTokenRetryBump({
          currentMaxOutputTokens: this.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model),
          modelMaxOutputTokens: routedMaxOutputTokens,
        });
        if (nextMaxOutputTokens !== undefined) {
          const previousOutput = this.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model);
          this.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
            requestedMaxOutputTokens: nextMaxOutputTokens,
          });
          yield {
            type: "token_cap_adjusted",
            sessionId: input.sessionId,
            turnId: input.turnId,
            provider: decision.provider,
            model: decision.model,
            cap: "output",
            previous: previousOutput,
            next: nextMaxOutputTokens,
            reason: "max-output-retry-bump",
          };
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          return { kind: "continue" };
        }
      }

      // Phase B: continuation recovery
      if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
        state.maxOutputRecoveryCount++;
        return yield* this.continueWithTransientPrompt(
          state,
          input,
          "Output token limit hit. Resume directly - no apology, no recap of what you were doing. " +
            "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
          "max_output_recovery",
        );
      }

      // Phase C: exhausted. Do not execute repaired/truncated calls; the
      // arguments may be syntactically repaired while semantically partial.
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "model_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [
          agentError(
            "agent_model_error",
            "Recovered tool call still looked repaired/truncated after max-output recovery was exhausted.",
          ),
        ],
      });
      yield await this.emitStatus(
        input,
        createToolCallRecoveryExhaustedStatus({
          error: result.errors![0]!,
          attempts: state.maxOutputRecoveryCount,
          reason: "repaired_truncated_tool_calls",
        }),
      );
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
    }

    if (!assembled.error && toolCalls.length === 0 && textFromMessage(assistantMessage).length === 0) {
      if (state.maxOutputRecoveryCount > 0) {
        state.consecutiveEmptyCount++;
        if (
          state.consecutiveEmptyCount < MAX_CONSECUTIVE_EMPTY &&
          state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT
        ) {
          state.maxOutputRecoveryCount++;
          yield* this.emitEmptyOutputTokenBump(input, decision, assembled.finishReason, routedMaxOutputTokens);
          return yield* this.continueWithTransientPrompt(
            state,
            input,
            "Output token limit hit. Resume directly - no apology, no recap of what you were doing. " +
              "Pick up mid-sentence if that is where the cut happened.",
            "max_output_recovery",
          );
        }
        state.finalMessage = state.messages.filter(m => m.role === "assistant").at(-1);
        const status = createEmptyResponseStatus({
          provider: request.provider,
          model: request.model,
          attempts: state.consecutiveEmptyCount,
        });
        yield await this.emitStatus(input, status);
        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage: state.usage,
          permissionDenials: state.permissionDenials,
          turns: state.turnCount,
          startedAt: state.startedAt,
          finalMessage: state.finalMessage,
        });
        return yield* this.terminateTurn(input, state, result, { errored: true });
      }

      if (!state.hasAttemptedEmptyRetry) {
        state.hasAttemptedEmptyRetry = true;
        state.maxOutputRecoveryCount++;
        yield* this.emitEmptyOutputTokenBump(input, decision, assembled.finishReason, routedMaxOutputTokens);
        return yield* this.continueWithTransientPrompt(
          state,
          input,
          "Your previous response was empty (thinking only, no visible text). " +
            "Please provide your answer as visible text output.",
          "empty_response_retry",
        );
      }

      const status = createEmptyResponseStatus({
        provider: request.provider,
        model: request.model,
        attempts: 2,
      });
      yield await this.emitStatus(input, status);
      const result = this.createTurnResult(input, {
        type: "success",
        stopReason: "completed",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.messages.filter(m => m.role === "assistant").at(-1),
      });
      return yield* this.terminateTurn(input, state, result, { errored: true });
    }

    state.messages.push(assistantMessage);
    yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: assistantMessage };
    await input.onDurableMessage?.(assistantMessage);

    return { kind: "proceed", assembled, assistantMessage, toolCalls };
  }

  private async *handleModelError(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    decision: RouterDecision,
    assembled: AssembledAssistantMessage,
    toolCalls: CanonicalToolCall[],
    routedMaxOutputTokens: number | undefined,
  ): AsyncGenerator<AgentEvent, ModelErrorRecoveredResult, unknown> {
    const ctx = this.dependencies.context;
    if (assembled.error) {
      if (!state.hasAttemptedReasoningContentRetry && isMissingReasoningContentError(assembled.error)) {
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

      if (toolCalls.length > 0) {
        const projected = projectToolResults(
          toolCalls.map(call =>
            createMissingToolResult(
              call,
              this.now,
              "Model error interrupted tool execution.",
              this.missingToolResultRecoveryContext(),
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

      if (
        this.config.jsonSelfCorrect &&
        assembled.error.code === "invalid_tool_arguments" &&
        state.jsonSelfCorrectCount < MAX_JSON_SELF_CORRECT_RETRIES
      ) {
        state.jsonSelfCorrectCount++;
        return yield* this.continueWithTransientPrompt(
          state,
          input,
          "Your previous tool call contained invalid JSON in the arguments and could not be parsed. " +
            "Please retry with valid JSON. Common issues: missing quotes around keys/values, " +
            "trailing commas, unescaped special characters in strings.",
          "json_self_correct",
        );
      }

      // Reactive recovery: ask context runtime if it can recover from the
      // model error (e.g. `prompt_too_long` → truncate head and retry).
      // Single-shot per turn — see legacy parity §3.1 #8.
      const reactive = await this.tryReactiveRecover(input, assembled.error, state.messages, state.hasAttemptedCompact);
      if (reactive && reactive.type === "adjust_output_and_retry" && !state.hasAttemptedOutputRetry) {
        state.hasAttemptedOutputRetry = true;
        const target = modelErrorTarget(assembled.error, decision.provider, decision.model);
        const previousOutput = this.tokenCaps.currentMaxOutputTokens(target.provider, target.model);
        this.tokenCaps.setTransientTokenCap(
          target.provider,
          target.model,
          reactive.scope === "attempt"
            ? { attemptMaxOutputTokens: reactive.maxOutputTokens }
            : { hardMaxOutputTokens: reactive.maxOutputTokens },
        );
        if (target.provider !== decision.provider || target.model !== decision.model) {
          this.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
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

      if (reactive && reactive.type === "compact_and_retry" && !state.hasAttemptedCompact) {
        const target = modelErrorTarget(assembled.error, decision.provider, decision.model);
        const previousContext = this.tokenCaps.currentMaxContextTokens(target.provider, target.model);
        if (reactive.maxContextTokens !== undefined) {
          this.tokenCaps.setTransientTokenCap(target.provider, target.model, {
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
          const previousOutput = this.tokenCaps.currentMaxOutputTokens(target.provider, target.model);
          this.tokenCaps.setTransientTokenCap(target.provider, target.model, {
            attemptMaxOutputTokens: reactive.maxOutputTokens,
          });
          if (target.provider !== decision.provider || target.model !== decision.model) {
            this.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
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
        if (ctx?.tryAutoCompact) {
          yield* this.runAutoCompact(state, input, {
            stage: "model-error-recovery",
            maxContextTokens: this.tokenCaps.currentMaxContextTokens(target.provider, target.model),
            reservedOutputTokens: this.tokenCaps.getReservedOutputTokens(target.provider, target.model),
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

      if (reactive && reactive.type === "truncate_head_and_retry") {
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

      if (reactive && reactive.type === "strip_images_and_retry") {
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

      // `max_output_reached`: output token limit hit (or truncated JSON
      // reclassified from invalid_tool_arguments when finishReason=length).
      //
      // Phase A — single-shot token doubling for explicit caps only.
      // Phase B — multi-turn continuation: keep the truncated assistant
      // message in context and inject a "resume" prompt so the model can
      // pick up where it was cut off (up to MAX_OUTPUT_RECOVERY_LIMIT).
      // Phase C — exhausted: fall through to error surfacing.
      if (assembled.error.code === "max_output_reached") {
        // Phase A
        if (!state.hasAttemptedOutputRetry) {
          state.hasAttemptedOutputRetry = true;
          const nextMaxOutputTokens = resolveOutputTokenRetryBump({
            currentMaxOutputTokens: this.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model),
            modelMaxOutputTokens: routedMaxOutputTokens,
          });
          if (nextMaxOutputTokens !== undefined) {
            state.messages = stripTrailingErrorPair(state.messages);
            const previousOutput = this.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model);
            this.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
              requestedMaxOutputTokens: nextMaxOutputTokens,
            });
            yield {
              type: "token_cap_adjusted",
              sessionId: input.sessionId,
              turnId: input.turnId,
              provider: decision.provider,
              model: decision.model,
              cap: "output",
              previous: previousOutput,
              next: nextMaxOutputTokens,
              reason: "max-output-retry-bump",
            };
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            return { kind: "continue" };
          }
        }

        // Phase B
        if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
          state.maxOutputRecoveryCount++;
          return yield* this.continueWithTransientPrompt(
            state,
            input,
            "Output token limit hit. Resume directly - no apology, no recap of what you were doing. " +
              "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
            "max_output_recovery",
          );
        }
        // Phase C: fall through to error surfacing
      }

      // Cross-provider fallback decisions are now owned by RouterRuntime
      // (see `runFallbackChain` + `zeroUsageRetry`); the loop only
      // classifies the surfaced error and falls through.
      const classified = classifyModelError(assembled.error);
      await this.dispatchLifecycle(input, "StopFailure", { error: assembled.error });
      yield {
        type: "stop_failure",
        sessionId: input.sessionId,
        turnId: input.turnId,
        error: typeof assembled.error === "string" ? assembled.error : JSON.stringify(assembled.error),
      };
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: classified.stopReason,
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        errors: [classified.error],
      });
      yield await this.emitStatus(
        input,
        createModelRequestFailedStatus({
          error: classified.error,
          modelError: assembled.error,
        }),
      );
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
    }

    return { kind: "continue" };
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

        if (state.maxOutputRecoveryCount > 0) {
          state.consecutiveEmptyCount++;
          if (
            state.consecutiveEmptyCount < MAX_CONSECUTIVE_EMPTY &&
            state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT
          ) {
            state.maxOutputRecoveryCount++;
            yield* this.emitEmptyOutputTokenBump(input, decision, assembled.finishReason, routedMaxOutputTokens);
            return yield* this.continueWithTransientPrompt(
              state,
              input,
              "Output token limit hit. Resume directly - no apology, no recap of what you were doing. " +
                "Pick up mid-sentence if that is where the cut happened.",
              "max_output_recovery",
            );
          }
          // Exhausted consecutive empty retries — surface a UI-only status
          // message instead of injecting diagnostic assistant text into the
          // model transcript.
          state.finalMessage = state.messages.filter(m => m.role === "assistant").at(-1);
          const status = createEmptyResponseStatus({
            provider: request.provider,
            model: request.model,
            attempts: state.consecutiveEmptyCount,
          });
          yield await this.emitStatus(input, status);
          const result = this.createTurnResult(input, {
            type: "success",
            stopReason: "completed",
            usage: state.usage,
            permissionDenials: state.permissionDenials,
            turns: state.turnCount,
            startedAt: state.startedAt,
            finalMessage: state.finalMessage,
          });
          return yield* this.terminateTurn(input, state, result, { errored: true });
        } else if (!state.hasAttemptedEmptyRetry) {
          // First occurrence: prompt the model to produce visible output.
          state.hasAttemptedEmptyRetry = true;
          state.maxOutputRecoveryCount++;
          yield* this.emitEmptyOutputTokenBump(input, decision, assembled.finishReason, routedMaxOutputTokens);
          return yield* this.continueWithTransientPrompt(
            state,
            input,
            "Your previous response was empty (thinking only, no visible text). " +
              "Please provide your answer as visible text output.",
            "empty_response_retry",
          );
        } else {
          const status = createEmptyResponseStatus({
            provider: request.provider,
            model: request.model,
            attempts: 2,
          });
          yield await this.emitStatus(input, status);
        }
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
          return yield* this.continueWithTransientPrompt(
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
        yield await this.emitStatus(input, status);
      }

      const largeFileDecision = state.largeFileRepair.onNoToolCalls();
      if (largeFileDecision) {
        const continued = await this.continueWithSyntheticPrompt(state, input, largeFileDecision);
        if (continued.type === "completed") {
          if (continued.status) {
            yield await this.emitStatus(input, continued.status);
          }
          return yield* this.terminateTurn(input, state, continued.result, { emitFailureEvent: true });
        }
        yield continued.event;
        return { kind: "continue" };
      }

      if (!assembled.hasPartialTextToolCall && assembled.hasUnparsedTextToolCall) {
        if (!state.hasAttemptedToolCallRetry) {
          state.hasAttemptedToolCallRetry = true;
          return yield* this.continueWithTransientPrompt(
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
        yield await this.emitStatus(
          input,
          createLifecycleBlockedStatus({
            error: result.errors![0]!,
            stage: "stop",
          }),
        );
        return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
      }
      const finishStatus = createFinishReasonStatus(assembled.finishReason, assistantText);
      if (finishStatus) {
        yield await this.emitStatus(input, finishStatus);
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
      return yield* this.terminateTurn(input, state, result);
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
      return yield* this.abortTurn(input, state);
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
      return yield* this.abortTurn(input, state);
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
          yield await this.emitStatus(input, continued.status);
        }
        return yield* this.terminateTurn(input, state, continued.result, { emitFailureEvent: true });
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
      yield await this.emitStatus(
        input,
        createLifecycleBlockedStatus({
          error: result.errors![0]!,
          stage: "tool_lifecycle",
        }),
      );
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
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
            yield await this.emitStatus(input, continued.status);
          }
          return yield* this.terminateTurn(input, state, continued.result, { emitFailureEvent: true });
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
          return yield* this.continueWithTransientPrompt(
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
        yield await this.emitStatus(
          input,
          createToolErrorLoopStatus({
            error: result.errors![0]!,
            repeatedFailures: state.sameInvalidFingerprintCount,
          }),
        );
        return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
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
      yield await this.emitStatus(input, status);
      return yield* this.terminateTurn(input, state, result);
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
      yield await this.emitStatus(input, status);
      return yield* this.terminateTurn(input, state, result, { emitFailureEvent: true });
    }

    state.turnCount = nextTurnCount;
    yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "next_turn" };
    return { kind: "continue" };
  }

  private async emitStatus(input: AgentLoopInput, status: AgentStatusMessage): Promise<AgentEvent> {
    await input.onAgentStatusMessage?.(status);
    return {
      type: "agent_status",
      sessionId: input.sessionId,
      turnId: input.turnId,
      event: status.event,
      detail: status.detail,
    };
  }

  private createAbortStatus(input: AgentLoopInput): AgentStatusMessage | undefined {
    if (!shouldSurfaceAbortStatus(input.abortSignal?.reason)) return undefined;
    return createTurnAbortedStatus({ reason: stringifyAbortReason(input.abortSignal?.reason) });
  }

  /**
   * 空响应恢复的 token 倍增（finishReason=length 时）：clamp 倍增（含 floor）
   * → 设置 transient cap → empty_output_recovery 事件。此前 4 处逐字重复。
   */
  private async *emitEmptyOutputTokenBump(
    input: AgentLoopInput,
    decision: RouterDecision,
    finishReason: string | undefined,
    routedMaxOutputTokens: number | undefined,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    if (finishReason !== "length") return;
    const previousMaxOutputTokens = this.tokenCaps.currentMaxOutputTokens(decision.provider, decision.model);
    const nextMaxOutputTokens = clampOutputToModelCap(
      Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
      routedMaxOutputTokens,
    );
    if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
      this.tokenCaps.setTransientTokenCap(decision.provider, decision.model, {
        requestedMaxOutputTokens: nextMaxOutputTokens,
      });
      yield {
        type: "empty_output_recovery",
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: decision.provider,
        model: decision.model,
        finishReason,
        previousMaxOutputTokens,
        nextMaxOutputTokens,
      };
    }
  }

  /**
   * 恢复路径的「注入 transient 提示并继续」：push 提示 + turn_continued
   * (model_error) + continue。此前 6+ 处逐字重复收敛于此。
   */
  private async *continueWithTransientPrompt(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    prompt: string,
    purpose: string,
  ): AsyncGenerator<AgentEvent, TurnStepContinue, unknown> {
    state.pushTransientSyntheticPrompt(prompt, purpose);
    yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "model_error" };
    return { kind: "continue" };
  }

  /**
   * 统一 turn 终止仪式：可选的 turn_failed 事件 → captureTurn → turn_completed →
   * return。所有失败/中止/完成出口共用，消除 ~25 处复制粘贴并保证事件顺序
   * 一致（此前各出口散落 captureTurn，漏写会静默丢 turn 记录）。
   */
  private async *terminateTurn(
    input: AgentLoopInput,
    state: TurnRuntimeState,
    result: AgentTurnResult,
    options: { emitFailureEvent?: boolean; errored?: boolean } = {},
  ): AsyncGenerator<AgentEvent, TurnStepReturn, unknown> {
    if (options.emitFailureEvent) {
      yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
    }
    await this.captureTurn(input, state, options.errored ?? result.type === "error");
    yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
    return { kind: "return", result, messages: state.messages };
  }

  /**
   * 中止时捕获已部分生成的 assistant 消息（有内容才落库），供 abort 出口
   * 复用。此前 streamModelResponse 的 catch / 正常路径两处逐字重复。
   */
  private async *captureAbortedPartial(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    assembler: ReturnType<typeof createModelMessageAssemblerState>,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const partialAssembled = assembleAssistantMessage(assembler);
    if (partialAssembled.message.content.length > 0) {
      state.finalMessage = partialAssembled.message;
      state.messages.push(partialAssembled.message);
      state.expireConsumedTransientPrompts();
      state.usage = mergeUsage(state.usage, partialAssembled.usage);
      yield {
        type: "assistant_message",
        sessionId: input.sessionId,
        turnId: input.turnId,
        message: partialAssembled.message,
      };
      await input.onDurableMessage?.(partialAssembled.message);
    }
  }

  /**
   * 统一中止终止：createTurnResult(aborted) → 可选 abort 状态 → captureTurn →
   * turn_completed → return。此前 6 处 abort 块中 3 处不发射 abort 状态导致
   * UI 提示不一致，此处统一补齐。
   */
  private async *abortTurn(
    input: AgentLoopInput,
    state: TurnRuntimeState,
  ): AsyncGenerator<AgentEvent, TurnStepReturn, unknown> {
    const result = this.createTurnResult(input, {
      type: "aborted",
      stopReason: "aborted_streaming",
      usage: state.usage,
      permissionDenials: state.permissionDenials,
      turns: state.turnCount,
      startedAt: state.startedAt,
      finalMessage: state.finalMessage,
    });
    const status = this.createAbortStatus(input);
    if (status) {
      yield await this.emitStatus(input, status);
    }
    await this.captureTurn(input, state, result.type === "error");
    yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
    return { kind: "return", result, messages: state.messages };
  }

  private async captureTurn(input: AgentLoopInput, state: TurnRuntimeState, errored: boolean): Promise<void> {
    const hook = this.dependencies.context?.captureTurn;
    if (!hook) return;
    try {
      await hook.call(this.dependencies.context, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        messages: state.messages,
        errored,
      });
    } catch {
      // captureTurn must never break a turn — context impl already
      // swallows; this catch is defensive.
    }
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
  ): Promise<
    | {
        type: "continue";
        event: AgentEvent;
      }
    | {
        type: "completed";
        result: AgentTurnResult;
        status?: AgentStatusMessage;
      }
  > {
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

  private async tryReactiveRecover(
    input: AgentLoopInput,
    error: CanonicalModelError,
    messages: CanonicalMessage[],
    hasAttemptedCompact: boolean,
  ): Promise<ContextRecoveryDecision | undefined> {
    const ctx: AgentContextRuntime | undefined = this.dependencies.context;
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

  private async createModelRequest(
    messages: CanonicalMessage[],
    input: AgentLoopInput,
    options: { emitInstructionEvents?: boolean; state?: TurnRuntimeState } = {},
  ): Promise<CanonicalModelRequest> {
    const contextRuntime = this.dependencies.context ?? new NullContextRuntime();
    const planTodo = this.dependencies.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const promptBlockedToolNames = canPrompt
      ? new Set<string>()
      : new Set(
          this.dependencies.tools.registry
            .list()
            .filter(tool => requiresPromptCapability(tool, {}))
            .map(tool => tool.name),
        );
    let toolDefinitions = this.dependencies.tools.registry
      .list()
      .filter(tool => !promptBlockedToolNames.has(tool.name));
    if (input.allowPlanModeTools !== true) {
      toolDefinitions = toolDefinitions.filter(
        tool => tool.name !== "enter_plan_mode" && tool.name !== "exit_plan_mode",
      );
    }
    const requestMessages = normalizeMessagesForModelRequest(messages);
    let tools = toolDefinitions.map(toolToCanonicalSchema);
    if (this.config.runMode === "ask") {
      tools = filterAskModeTools(toolDefinitions);
    }
    const prepared = await contextRuntime.prepareForModel({
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: this.config.cwd,
      provider: this.config.provider,
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      runMode: this.config.runMode ?? "agent",
      additionalWorkingDirectories: this.config.permissionContext.additionalWorkingDirectories,
      messages: cloneMessages(requestMessages),
      tools,
      maxMessages: this.config.maxContextMessages,
      customSystemPrompt: this.config.systemPrompt,
      appendSystemPrompt: planTodo?.buildPromptAddendum(),
      abortSignal: input.abortSignal,
    });

    if (options.emitInstructionEvents !== false) {
      this.dispatchLifecycle(input, "InstructionsLoaded", {
        hasSystemPrompt: !!prepared.systemPrompt,
      }).catch(error => console.warn("[agent] InstructionsLoaded lifecycle dispatch failed:", error));
      this.dependencies.eventEmitter?.({
        type: "instructions_loaded",
        sessionId: input.sessionId,
        turnId: input.turnId,
        hasSystemPrompt: !!prepared.systemPrompt,
      });
    }

    const materialized = await materializeMediaReferences(prepared.messages);
    for (const diagnostic of materialized.diagnostics) {
      console.warn(`[sati] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.mediaType}, ${diagnostic.path})`);
    }

    // 单次计算方法论 addendum：既落库审计又拼 system prompt，避免同一 inject
    // 回调执行两次导致「记录文本 ≠ 模型实际所见」。
    const methodologyAddendum = computeMethodologyAddendum(requestMessages, this.config.methodologyInjection);

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
      provider: this.config.provider,
      model: this.config.model,
      messages:
        this.config.permissionMode === "plan" ? appendPlanModeReminder(materialized.messages) : materialized.messages,
      systemPrompt: applyMethodologyAddendum(
        prepared.systemPrompt ?? this.config.systemPrompt ?? "",
        methodologyAddendum,
      ),
      tools: prepared.tools,
      toolChoice: this.config.toolChoice,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      thinking: this.config.thinking,
      stream: true,
      // 阶段四 T4.2：请求级 retryScope——把 turnId 并入请求 metadata，使
      // streamModel 的 retryId 在同一 turn 的全部请求间稳定（跨路由 attempt
      // 与重试可审计关联）。Anthropic 降级只读 user_id；OpenAI 作为自定义
      // metadata 透传（可用于仪表盘请求关联）。
      metadata: { ...this.config.metadata, turnId: input.turnId },
      cacheBreakpoints: prepared.cacheBreakpoints,
    };
  }

  private createBudgetEvaluator(
    input: AgentLoopInput,
    options: {
      decision?: RouterDecision;
      baseRequest?: CanonicalModelRequest;
      maxContextTokens?: number;
      reservedOutputTokens: number;
    },
  ): ((candidateMessages: CanonicalMessage[], lastUsage?: CanonicalUsage) => Promise<TokenBudgetSnapshot>) | undefined {
    const tokenAccounting = this.dependencies.tokenAccounting;
    const maxContextTokens = options.maxContextTokens;
    if (!tokenAccounting || !maxContextTokens) {
      return undefined;
    }
    return async (candidateMessages, lastUsage) => {
      let candidateRequest = await this.createModelRequest(candidateMessages, input, {
        emitInstructionEvents: false,
      });
      if (options.decision && options.baseRequest && this.dependencies.router.materializeRequest) {
        const patchedBase = { ...options.baseRequest, messages: candidateRequest.messages };
        candidateRequest = this.dependencies.router.materializeRequest(options.decision, {
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

  /**
   * 单一压缩执行器：统一 tryAutoCompact 的参数组装、compacted 结果处理
   * （替换 messages + persistCompactSnapshot + 可选 auto_compact 事件）与
   * 失败降级（logAutoCompactFailure + 可选 truncateHeadKeepRatio 兜底）。
   * 调用点差异（request 重建 / context_budget 事件 / 外层 turn_continued）
   * 保留在调用点。无 tryAutoCompact 时直接返回未压缩。
   */
  private async *runAutoCompact(
    state: TurnRuntimeState,
    input: AgentLoopInput,
    options: {
      stage: "pre-routing" | "post-routing" | "model-error-recovery";
      maxContextTokens?: number;
      reservedOutputTokens: number;
      budgetEvaluator?: (
        candidateMessages: CanonicalMessage[],
        lastUsage?: CanonicalUsage,
      ) => Promise<TokenBudgetSnapshot>;
      emitAutoCompactEvent?: boolean;
      fallbackTruncateRatio?: number;
    },
  ): AsyncGenerator<AgentEvent, { compacted: boolean; snapshot?: TokenBudgetSnapshot }, unknown> {
    const ctx = this.dependencies.context;
    if (!ctx?.tryAutoCompact) {
      return { compacted: false };
    }
    // transient synthetic prompts（恢复提示）从未落库，但可能仍在
    // state.messages 中（上一轮 assemble 阶段才 expire，而本阶段在下一轮
    // prepareModelCall 开头先于 assemble 执行）。压缩输入若包含它们，遮蔽
    // 重建序列（transcript 投影）会缺这些消息导致 shadowedRanges 错位。
    // 压缩前剥离，压缩产物后再追加回末尾（模型尚未消费它们）。
    const { persistent: compactInputMessages, transient: transientPrompts } = splitTransientPrompts(state.messages);
    try {
      const compact = await ctx.tryAutoCompact({
        sessionId: input.sessionId,
        turnId: input.turnId,
        messages: compactInputMessages,
        abortSignal: input.abortSignal,
        ...(options.maxContextTokens !== undefined ? { maxContextTokens: options.maxContextTokens } : {}),
        reservedOutputTokens: options.reservedOutputTokens,
        lastUsage: state.lastModelUsage,
        ...(options.budgetEvaluator !== undefined ? { budgetEvaluator: options.budgetEvaluator } : {}),
      });
      if (compact.type === "compacted") {
        state.messages = [...compact.messages, ...transientPrompts];
        await this.persistCompactSnapshot(input, compact);
        if (options.emitAutoCompactEvent !== false) {
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "auto_compact",
          };
        }
        return { compacted: true, snapshot: compact.snapshot };
      }
      if (options.fallbackTruncateRatio !== undefined) {
        state.messages = [
          ...truncateHeadKeepRatio(compactInputMessages, options.fallbackTruncateRatio),
          ...transientPrompts,
        ];
      }
      return { compacted: false, snapshot: compact.snapshot };
    } catch (error: unknown) {
      logAutoCompactFailure(options.stage, input, error);
      if (options.fallbackTruncateRatio !== undefined) {
        state.messages = [
          ...truncateHeadKeepRatio(compactInputMessages, options.fallbackTruncateRatio),
          ...transientPrompts,
        ];
      }
      return { compacted: false };
    }
  }

  private async persistCompactSnapshot(
    input: AgentLoopInput,
    compact: Extract<AutoCompactResult, { type: "compacted" }>,
  ): Promise<void> {
    if (!input.onCompactPersisted || !compact.result) {
      return;
    }
    const shadowedRanges = compact.result.shadowedMessageIndexes
      ? compressIndexRanges(compact.result.shadowedMessageIndexes)
      : undefined;
    const boundary: AgentControlBoundaryTranscriptEntry["boundary"] = {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        compactionId: compact.result.compactionId,
        trigger: compact.result.trigger,
        preTokens: compact.result.preTokens,
        ...(compact.result.postTokens !== undefined ? { postTokens: compact.result.postTokens } : {}),
        messagesSummarized: compact.result.messagesSummarized,
        ...(shadowedRanges !== undefined && shadowedRanges.length > 0 ? { shadowedRanges } : {}),
        extra: {
          tier: compact.tier,
          summarySucceeded: compact.result.error === undefined,
        },
      },
    };
    await Promise.resolve(
      input.onCompactPersisted({
        boundary,
        messages: markCompactReplacementMessages(compact.messages),
      }),
    ).catch(error => console.warn("[agent] onCompactPersisted failed:", error));
  }

  private repairTextExtractedToolNames(
    message: CanonicalMessage,
    toolCalls: CanonicalToolCall[],
  ): { message: CanonicalMessage; toolCalls: CanonicalToolCall[] } {
    if (toolCalls.length === 0) return { message, toolCalls };
    const validNames = new Set(this.dependencies.tools.registry.list().map(tool => tool.name));
    const repairedById = new Map<string, string>();
    const repairedToolCalls = toolCalls.map(call => {
      const repaired = repairToolName(call.name, validNames, this.config.toolAliases);
      if (!repaired) return call;
      repairedById.set(call.id, repaired.name);
      return { ...call, name: repaired.name };
    });
    if (repairedById.size === 0) return { message, toolCalls };

    return {
      message: {
        ...message,
        content: message.content.map(block => {
          if (block.type !== "tool_call") return block;
          const repairedName = repairedById.get(block.id);
          return repairedName ? ({ ...block, name: repairedName } satisfies CanonicalToolCallBlock) : block;
        }),
      },
      toolCalls: repairedToolCalls,
    };
  }

  private createTurnResult(
    input: AgentLoopInput,
    options: Omit<AgentTurnResult, "sessionId" | "turnId" | "completedAt">,
  ): AgentTurnResult {
    return {
      ...options,
      sessionId: input.sessionId,
      turnId: input.turnId,
      completedAt: this.now().toISOString(),
    };
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
