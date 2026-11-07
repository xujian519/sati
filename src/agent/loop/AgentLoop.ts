import {
  applyModelEventToAssembler,
  createModelMessageAssemblerState,
  type CanonicalMessage,
  ModelProviderError,
  type CanonicalModelRequest,
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
import type { RouterDecision, RouterDispatchReport } from "../../router/index.js";
import { createModelContextSnapshot } from "../../session/context/ModelContextSnapshot.js";
import type { AgentRunMode, AgentLoopInput } from "../protocol/input.js";
import { buildRequestHeaderSnapshot, verifyDispatchedRequest } from "./requestInvariant.js";
import type { LargeFileRepairDecision } from "./LargeFileRepair.js";
import { MAX_SAME_INVALID_FINGERPRINT, TurnRuntimeState } from "./turnRuntimeState.js";
import { RepeatTracker } from "./repeatToolReminder.js";
import { buildSteerMessage, steerPreview } from "./steer.js";
import {
  cloneReadFileStateMap,
  cloneWriteSnapshotMap,
  createLifecycleDispatcher,
  findLifecycleBlock,
  mergeUserRules,
  type LifecycleDispatcher,
} from "./misc.js";
import { stripTrailingErrorPair } from "./messages.js";
import { buildInvalidFingerprint } from "./toolFailure.js";
import {
  createLifecycleBlockedStatus,
  createMaxTurnsStatus,
  createModelRequestFailedStatus,
  createStructuredOutputCompletedStatus,
  createToolErrorLoopStatus,
} from "./modelErrors.js";
import { handleNoToolCalls, type NoToolCallsDeps } from "./noToolCalls.js";
import { executeToolCalls, type ToolCallExecutionDeps } from "./toolCallExecution.js";
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
import { continueWithTransientPrompt } from "./recoveryStrategies.js";
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
  private readonly noToolCallsDeps: NoToolCallsDeps;
  private readonly toolCallExecutionDeps: ToolCallExecutionDeps;

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
      ...(dependencies.recordObservedContextWindow
        ? { recordObservedContextWindow: dependencies.recordObservedContextWindow }
        : {}),
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
    this.noToolCallsDeps = {
      ...this.turnExit,
      config,
      dispatchLifecycle: this.dispatchLifecycle,
      continueWithSyntheticPrompt: (state, input, decision, options) =>
        this.continueWithSyntheticPrompt(state, input, decision, options),
    };
    this.toolCallExecutionDeps = {
      ...this.turnExit,
      config,
      toolContextFactory: this.toolContextFactory,
      subagentExecutor: this.subagentExecutor,
      repeatTracker: this.repeatTracker,
      doomLoop: dependencies.doomLoop,
      eventEmitter: dependencies.eventEmitter,
      context: dependencies.context,
      missingToolResultRecoveryContext: () => this.missingToolResultRecoveryContext(),
      continueWithSyntheticPrompt: (state, input, decision, options) =>
        this.continueWithSyntheticPrompt(state, input, decision, options),
    };
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
        const finished = yield* handleNoToolCalls(
          this.noToolCallsDeps,
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

      const executed = yield* executeToolCalls(
        this.toolCallExecutionDeps,
        state,
        input,
        assembled.toolCalls,
        assembled.assembled,
      );
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
    await input.onModelContext?.(createModelContextSnapshot(request, input.turnId));
    // 对拍不在此处做：旧实现在这里用同一对 (request, decision) 自比，恒真（#360）。
    // 现改为在**派发点**对拍（下方 onDispatchRequest），两侧不同源方能有牙齿。
    const verifyDispatch = process.env.SATI_VERIFY_REQUEST_RECONSTRUCTION === "1";
    const assembler = createModelMessageAssemblerState();
    try {
      for await (const event of this.dependencies.router.execute(decision, request, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        projectPath: this.config.cwd,
        abortSignal: input.abortSignal,
        // 生产判据（#360）：实际派发形态 vs 发送前落盘的快照，差异只允许落在
        // 本次派发的改写标签声明过的字段内；未声明的改写在此 fail-loud。
        ...(verifyDispatch
          ? {
              onDispatchRequest: (report: RouterDispatchReport): void => {
                verifyDispatchedRequest({ persisted: requestHeader, report });
              },
            }
          : {}),
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
