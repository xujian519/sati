import type { CanonicalMessage } from "../../model/index.js";
import type { SatiReadFileStateMap, SatiWriteSnapshotMap } from "../../tool/protocol/types.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";
import type { AgentRunMode, AgentLoopInput } from "../protocol/input.js";
import { TurnRuntimeState } from "./turnRuntimeState.js";
import { RepeatTracker } from "./repeatToolReminder.js";
import {
  cloneReadFileStateMap,
  cloneWriteSnapshotMap,
  createLifecycleDispatcher,
  mergeUserRules,
  type LifecycleDispatcher,
} from "./misc.js";
import { handleNoToolCalls, type NoToolCallsDeps } from "./noToolCalls.js";
import { executeToolCalls, type ToolCallExecutionDeps } from "./toolCallExecution.js";
import { TokenCapManager } from "./tokenCapManager.js";
import { ToolContextFactory } from "./toolContext.js";
import { SubagentExecutor } from "./subagentExecutor.js";
import type { TurnExitDeps } from "./turnExit.js";
import { recoverFromModelError, type ModelErrorRecoveryDeps } from "./modelErrorRecovery.js";
import { assembleAndRecover, type ResponseAssemblyDeps } from "./responseAssembly.js";
import { runAutoCompact } from "./compactionExecutor.js";
import { handleCircuitBreaker, type CircuitBreakerDeps } from "./phases/circuitBreaker.js";
import { finishTurn, type FinishTurnDeps } from "./phases/finishTurn.js";
import { prepareModelCall, type ModelCallDeps } from "./phases/modelCall.js";
import { applySteeredMessages, type SteeringDeps } from "./phases/steering.js";
import { streamModelResponse, type StreamResponseDeps } from "./phases/streamResponse.js";
import {
  continueWithSyntheticPrompt,
  missingToolResultRecoveryContext,
  type SyntheticPromptDeps,
} from "./phases/syntheticPrompt.js";
import { runTurnGuards, type TurnGuardsDeps } from "./phases/turnGuards.js";

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
  private readonly noToolCallsDeps: NoToolCallsDeps;
  private readonly toolCallExecutionDeps: ToolCallExecutionDeps;
  private readonly turnGuardsDeps: TurnGuardsDeps;
  private readonly steeringDeps: SteeringDeps;
  private readonly finishTurnDeps: FinishTurnDeps;
  private readonly modelCallDeps: ModelCallDeps;
  private readonly streamResponseDeps: StreamResponseDeps;
  private readonly circuitBreakerDeps: CircuitBreakerDeps;
  private readonly syntheticPromptDeps: SyntheticPromptDeps;

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
      missingToolResultRecoveryContext: () => missingToolResultRecoveryContext(config),
      dispatchLifecycle: this.dispatchLifecycle,
      runAutoCompact: (state, input, options) => runAutoCompact(this.dependencies.context, state, input, options),
      ...(dependencies.recordObservedContextWindow
        ? { recordObservedContextWindow: dependencies.recordObservedContextWindow }
        : {}),
    };
    const modelRequest = { config, dependencies, dispatchLifecycle: this.dispatchLifecycle };
    this.responseAssembly = {
      ...this.turnExit,
      doomLoop: dependencies.doomLoop,
      eventEmitter: dependencies.eventEmitter,
      listToolNames: () => this.dependencies.tools.registry.list().map(tool => tool.name),
      toolAliases: config.toolAliases,
      continueWithSyntheticPrompt: (state, input, decision, options) =>
        continueWithSyntheticPrompt(this.syntheticPromptDeps, state, input, decision, options),
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
        continueWithSyntheticPrompt(this.syntheticPromptDeps, state, input, decision, options),
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
      missingToolResultRecoveryContext: () => missingToolResultRecoveryContext(config),
      continueWithSyntheticPrompt: (state, input, decision, options) =>
        continueWithSyntheticPrompt(this.syntheticPromptDeps, state, input, decision, options),
    };
    this.turnGuardsDeps = { ...this.turnExit, dispatchLifecycle: this.dispatchLifecycle };
    this.steeringDeps = { dependencies };
    this.finishTurnDeps = { ...this.turnExit, config };
    this.syntheticPromptDeps = { config, now: this.now };
    this.modelCallDeps = {
      ...this.turnExit,
      config,
      dependencies,
      dispatchLifecycle: this.dispatchLifecycle,
      modelRequest,
      subagentExecutor: this.subagentExecutor,
    };
    this.streamResponseDeps = {
      ...this.turnExit,
      config,
      dependencies,
      dispatchLifecycle: this.dispatchLifecycle,
    };
    this.circuitBreakerDeps = {
      ...this.turnExit,
      continueWithSyntheticPrompt: (state, input, decision, options) =>
        continueWithSyntheticPrompt(this.syntheticPromptDeps, state, input, decision, options),
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
      const guards = yield* runTurnGuards(this.turnGuardsDeps, state, input);
      if (guards.kind === "return") return { result: guards.result, messages: guards.messages };

      yield* applySteeredMessages(this.steeringDeps, state, input);

      const prepared = yield* prepareModelCall(this.modelCallDeps, state, input);
      if (prepared.kind === "return") return { result: prepared.result, messages: prepared.messages };

      const streamed = yield* streamModelResponse(
        this.streamResponseDeps,
        state,
        input,
        prepared.request,
        prepared.decision,
      );
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

      const breaker = yield* handleCircuitBreaker(this.circuitBreakerDeps, state, input, executed.pairedResults);
      if (breaker.kind === "return") return { result: breaker.result, messages: breaker.messages };

      const next = yield* finishTurn(this.finishTurnDeps, state, input);
      if (next.kind === "return") return { result: next.result, messages: next.messages };
    }
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
