/**
 * WorkflowEngine — DAG-based workflow execution engine.
 *
 * Adapted from XiaoNuo Agent's `engine.ts`, stripped of Nuo-specific
 * dependencies (`ReasoningStrategyConfig`, `BaseAgentDefinition`,
 * `SceneCategory`, `WORKFLOW_FALLBACK_MODEL`). Executes a {@link WorkflowPlan}
 * by running all ready steps in parallel (Promise.allSettled), honoring
 * conditions, retries, failure strategies, checkpoints and persistence.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { WorkflowPlanStore } from "../persistence/WorkflowPlanStore.js";
import type {
  WorkflowAgentFactory,
  WorkflowCheckpointDecision,
  WorkflowCheckpointHandler,
  WorkflowEvent,
  WorkflowEventSink,
  WorkflowPlan,
  WorkflowPlanAdjustment,
  WorkflowRetryPolicy,
  WorkflowStep,
  WorkflowStepOutput,
  WorkflowWorkerDefinition,
} from "../protocol/types.js";
import { WorkflowCheckpointError } from "../checkpoint/CheckpointHandler.js";
import { WorkflowWorkerError } from "../worker/WorkerResolver.js";
import { WorkflowConditionError, evaluateConditionExpression } from "./SafeEvaluator.js";
import { WorkflowInputError, resolveInputTemplate, type WorkflowStepOutputs } from "./InputResolver.js";

export type WorkflowEngineOptions = {
  /** Registry of named worker definitions. Required. */
  workerResolver: {
    resolve(name: string): WorkflowWorkerDefinition;
  };
  /** Creates the agent that executes a step. Required. */
  createAgent: WorkflowAgentFactory;
  /** Checkpoint handler. Defaults to auto-approve. */
  checkpointHandler?: WorkflowCheckpointHandler;
  /** Event sink for lifecycle events. */
  eventSink?: WorkflowEventSink;
  /** Persistence backend for step progress. */
  persist?: WorkflowPlanStore;
  /** Retry policy. Defaults to no retries. */
  retryPolicy?: WorkflowRetryPolicy;
  /** Model used by the `model_fallback` failure strategy. */
  fallbackModel?: string;
  /**
   * 每波就绪步骤的最大并行执行数（默认 4）。计划含大量独立步骤时防止
   * 同时拉起 N 个 LLM 会话（成本与令牌放大）。
   */
  maxParallel?: number;
  logger?: {
    warn: (msg: string, data?: Record<string, unknown>) => void;
  };
};

type ExecutionState = {
  plan: WorkflowPlan;
  stepOutputs: WorkflowStepOutputs;
  pausedAtCheckpoint?: string;
};

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_PARALLEL = 4;

/** Thrown for plan validation errors (cycles, missing workers, bad input). */
export class WorkflowPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPlanError";
  }
}

/** Internal marker: step should be marked skipped per the onFailure=skip strategy. */
class WorkflowSkipError extends Error {
  constructor(stepId: string, cause: unknown) {
    super(`Step "${stepId}" skipped after failure: ${String(cause)}`);
    this.name = "WorkflowSkipError";
  }
}

export class WorkflowEngine {
  private readonly executions = new Map<string, ExecutionState>();
  /** One-shot checkpoint decisions supplied by `resume()`; each is consumed by exactly one checkpoint. */
  private readonly pausedDecisions = new Map<string, WorkflowCheckpointDecision>();
  /** Resolvers for in-flight checkpoint waits (at most one per plan id), so `resume()` can deliver a decision to the awaiting loop. */
  private readonly checkpointWaiters = new Map<string, (decision: WorkflowCheckpointDecision) => void>();
  private readonly workerResolver: WorkflowEngineOptions["workerResolver"];
  private readonly createAgent: WorkflowAgentFactory;
  private readonly checkpointHandler: WorkflowCheckpointHandler;
  private readonly eventSink?: WorkflowEventSink;
  private readonly persist?: WorkflowPlanStore;
  private readonly retryPolicy: Required<WorkflowRetryPolicy>;
  private readonly fallbackModel?: string;
  private readonly maxParallel: number;
  private readonly logger?: WorkflowEngineOptions["logger"];

  constructor(options: WorkflowEngineOptions) {
    this.workerResolver = options.workerResolver;
    this.createAgent = options.createAgent;
    this.checkpointHandler = options.checkpointHandler ?? {
      waitForDecision: async () => ({ action: "approve" as const }),
    };
    this.eventSink = options.eventSink;
    this.persist = options.persist;
    this.retryPolicy = {
      maxRetries: options.retryPolicy?.maxRetries ?? 0,
      delayMs: options.retryPolicy?.delayMs ?? DEFAULT_RETRY_DELAY_MS,
      exponentialBackoff: options.retryPolicy?.exponentialBackoff ?? false,
    };
    this.fallbackModel = options.fallbackModel;
    this.maxParallel = Math.max(1, options.maxParallel ?? DEFAULT_MAX_PARALLEL);
    this.logger = options.logger;
  }

  /**
   * Execute a workflow plan to completion. The returned plan carries final
   * step statuses and outputs. Throws {@link WorkflowPlanError} on validation
   * failure; the returned plan has status `failed` when a step fails.
   */
  async execute(plan: WorkflowPlan): Promise<WorkflowPlan> {
    const working = structuredClone(plan);
    working.status = "running";
    working.updatedAt = new Date();
    this.validatePlan(working);
    this.emit({ type: "workflow_started", planId: working.id });

    const state: ExecutionState = { plan: working, stepOutputs: {} };
    this.executions.set(working.id, state);

    try {
      await this.runLoop(state);
    } finally {
      this.executions.delete(working.id);
      this.pausedDecisions.delete(working.id);
      this.checkpointWaiters.delete(working.id);
    }
    return state.plan;
  }

  /** Pause an in-flight execution (cooperative — takes effect at next checkpoint). */
  async pause(planId: string): Promise<void> {
    const state = this.executions.get(planId);
    if (!state) throw new WorkflowPlanError(`Execution "${planId}" is not running`);
    state.plan.status = "paused";
    this.emit({ type: "workflow_paused", planId });
  }

  /**
   * Resume a paused execution, optionally supplying the checkpoint decision.
   * @param decision When provided, resolves the pending checkpoint.
   */
  async resume(planId: string, decision?: WorkflowCheckpointDecision): Promise<WorkflowPlan> {
    const state = this.executions.get(planId);
    if (!state) {
      // Execution already finished; return the final plan from persistence if available.
      if (this.persist) {
        const stored = await this.persist.loadPlan(planId);
        if (stored) return stored;
      }
      throw new WorkflowPlanError(`Execution "${planId}" is not running`);
    }
    if (decision) {
      if (!state.pausedAtCheckpoint) {
        throw new WorkflowPlanError(`Execution "${planId}" has no pending checkpoint`);
      }
      // Deliver the decision directly to the in-flight checkpoint wait when
      // one exists; otherwise stash it for the next checkpoint. Either way a
      // decision is consumed by exactly one checkpoint.
      const waiter = this.checkpointWaiters.get(planId);
      if (waiter) {
        this.checkpointWaiters.delete(planId);
        waiter(decision);
      } else {
        this.pausedDecisions.set(planId, decision);
      }
    }
    if (state.plan.status === "paused") {
      state.plan.status = "running";
      // Do NOT re-enter the run loop here: the original loop is still
      // awaiting the checkpoint decision (this resume delivered it above),
      // so re-entering would run two loops over the same state concurrently.
    }
    return state.plan;
  }

  /** Apply runtime adjustments to a plan (add / remove / reorder / modify step). */
  adjustPlan(plan: WorkflowPlan, adjustments: WorkflowPlanAdjustment[]): WorkflowPlan {
    const working = structuredClone(plan);
    for (const adjustment of adjustments) {
      switch (adjustment.type) {
        case "add_step": {
          const index = adjustment.afterStepId
            ? working.steps.findIndex(step => step.id === adjustment.afterStepId) + 1
            : working.steps.length;
          if (index <= 0 && adjustment.afterStepId) {
            throw new WorkflowPlanError(`Cannot add after unknown step "${adjustment.afterStepId}"`);
          }
          working.steps.splice(index, 0, { ...adjustment.step, status: "pending" });
          break;
        }
        case "remove_step": {
          const index = working.steps.findIndex(step => step.id === adjustment.stepId);
          if (index === -1) throw new WorkflowPlanError(`Unknown step "${adjustment.stepId}"`);
          working.steps.splice(index, 1);
          for (const step of working.steps) {
            step.dependsOn = step.dependsOn?.filter(id => id !== adjustment.stepId);
          }
          break;
        }
        case "reorder": {
          const byId = new Map(working.steps.map(step => [step.id, step]));
          working.steps = adjustment.stepIds.map(id => {
            const step = byId.get(id);
            if (!step) throw new WorkflowPlanError(`Unknown step "${id}" in reorder`);
            return step;
          });
          break;
        }
        case "modify_step": {
          const step = working.steps.find(candidate => candidate.id === adjustment.stepId);
          if (!step) throw new WorkflowPlanError(`Unknown step "${adjustment.stepId}"`);
          Object.assign(step, adjustment.modifications);
          break;
        }
      }
    }
    working.updatedAt = new Date();
    this.validatePlan(working);
    return working;
  }

  // ————————————————————————————————————————————————
  // Internals
  // ————————————————————————————————————————————————

  private async runLoop(state: ExecutionState): Promise<void> {
    const plan = state.plan;
    while (true) {
      const { completed, total } = this.countStatuses(plan);
      if (completed >= total) {
        plan.status = "completed";
        plan.updatedAt = new Date();
        this.emit({ type: "workflow_completed", planId: plan.id });
        await this.persist?.savePlan(plan);
        return;
      }

      // 1. Evaluate conditions — skip steps whose condition is false and
      //    drop their downstream dependencies.
      for (const step of plan.steps) {
        if (step.status !== "pending" || !step.condition) continue;
        let shouldRun: boolean;
        try {
          shouldRun = evaluateConditionExpression(step.condition.expression, this.conditionContext(state));
        } catch (error) {
          const message = error instanceof WorkflowConditionError ? error.message : String(error);
          throw new WorkflowPlanError(`Condition on step "${step.id}" failed: ${message}`);
        }
        if (!shouldRun) {
          step.status = "skipped";
          this.emit({ type: "step_skipped", planId: plan.id, stepId: step.id });
        }
      }

      // 2. Find ready steps (all dependencies completed/skipped, not yet done).
      const ready = this.getReadySteps(plan);
      if (ready.length === 0) {
        throw new WorkflowPlanError(
          `Workflow "${plan.id}" is stuck: no ready steps but ${completed}/${total} complete (possible cycle or unsatisfiable dependencies)`,
        );
      }

      // 3. Run ready steps in parallel, honoring the maxParallel cap.
      const results = await this.runReadySteps(ready, state);

      // 4. Handle failures — any rejected step fails the plan.
      let failed = false;
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === "rejected") {
          failed = true;
          this.emit({
            type: "step_failed",
            planId: plan.id,
            stepId: ready[i]!.id,
            error: String(result.reason),
          });
        }
      }
      if (failed) {
        plan.status = "failed";
        plan.updatedAt = new Date();
        this.emit({ type: "workflow_failed", planId: plan.id, error: ready[0]?.id });
        await this.persist?.savePlan(plan);
        return;
      }

      // 5. Checkpoints for steps that completed with a checkpoint config.
      for (const step of ready) {
        if (step.status !== "completed" || !step.checkpoint) continue;
        const output = step.output;
        if (!output) continue;
        this.emit({ type: "checkpoint_reached", planId: plan.id, stepId: step.id });
        state.pausedAtCheckpoint = step.id;
        const decision = await this.awaitCheckpointDecision(state, step, output);
        state.pausedAtCheckpoint = undefined;
        if (decision.action === "reject") {
          plan.status = "paused";
          plan.updatedAt = new Date();
          this.emit({ type: "workflow_paused", planId: plan.id });
          await this.persist?.savePlan(plan);
          return;
        }
        if (decision.action === "edit" && decision.editedOutput) {
          step.output = decision.editedOutput;
          state.stepOutputs[step.id] = { status: "completed", output: decision.editedOutput };
        }
        if (decision.action === "skip") {
          step.status = "skipped";
          this.emit({ type: "step_skipped", planId: plan.id, stepId: step.id });
        }
        this.emit({ type: "checkpoint_decided", planId: plan.id, stepId: step.id, action: decision.action });
      }

      // 6. Persist progress.
      plan.updatedAt = new Date();
      await this.persist?.savePlan(plan);
    }
  }

  /**
   * 以 `maxParallel` 上限并发执行一批就绪步骤（信号量式 worker 池），
   * 返回与 `ready` 同序的 settled 结果，语义等价于原 `Promise.allSettled`。
   */
  private async runReadySteps(ready: WorkflowStep[], state: ExecutionState): Promise<PromiseSettledResult<void>[]> {
    const results = new Array<PromiseSettledResult<void>>(ready.length);
    const limit = Math.min(this.maxParallel, ready.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, limit) }, async () => {
      while (next < ready.length) {
        const index = next;
        next += 1;
        const step = ready[index]!;
        results[index] = await this.runOneStep(state, step);
      }
    });
    await Promise.allSettled(workers);
    return results;
  }

  /** 执行单个步骤并记录终态；WorkflowSkipError 时标记 skipped。 */
  private async runOneStep(state: ExecutionState, step: WorkflowStep): Promise<PromiseSettledResult<void>> {
    const planId = state.plan.id;
    try {
      this.emit({ type: "step_started", planId, stepId: step.id });
      const output = await this.runStep(state, step);
      step.output = output;
      step.status = "completed";
      state.stepOutputs[step.id] = { status: "completed", output };
      this.emit({ type: "step_completed", planId, stepId: step.id });
      return { status: "fulfilled", value: undefined };
    } catch (error) {
      if (error instanceof WorkflowSkipError) {
        step.status = "skipped";
        this.emit({ type: "step_skipped", planId, stepId: step.id });
        return { status: "fulfilled", value: undefined };
      }
      step.status = "failed";
      return { status: "rejected", reason: error };
    }
  }

  /** Run a single step with retries and failure strategies. */
  private async runStep(state: ExecutionState, step: WorkflowStep): Promise<WorkflowStepOutput> {
    const worker = this.workerResolver.resolve(step.worker.name);
    const onFailure = step.worker.onFailure ?? worker.onFailure ?? "fail";
    const maxAttempts = this.retryPolicy.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const input = await this.resolveStepInput(state, step);
        const agent = this.createAgent({
          systemPrompt: step.worker.systemPrompt ?? worker.systemPrompt,
          allowedTools: step.worker.allowedTools ?? worker.allowedTools,
          model: step.worker.model ?? worker.model,
        });
        try {
          return await agent.prompt(input);
        } finally {
          agent.destroy();
        }
      } catch (error) {
        if (attempt + 1 < maxAttempts) {
          // Retry with backoff.
          const delay = this.retryPolicy.exponentialBackoff
            ? this.retryPolicy.delayMs * 2 ** attempt
            : this.retryPolicy.delayMs;
          await sleep(delay);
          continue;
        }
        // Final attempt failed — apply the failure strategy.
        switch (onFailure) {
          case "skip":
            throw new WorkflowSkipError(step.id, error);
          case "default": {
            const fallback = step.worker.defaultValue ?? worker.defaultValue;
            if (!fallback) {
              throw new WorkflowPlanError(
                `Step "${step.id}" failed and onFailure=default requires a defaultValue (${String(error)})`,
              );
            }
            return fallback;
          }
          case "model_fallback":
            if (this.fallbackModel) {
              return this.runWithModelFallback(state, step, worker, error);
            }
            throw error;
          case "compact_and_retry":
            // Compact-and-retry needs input compaction, not yet implemented —
            // degrade to a plan failure with a clear message.
            throw new WorkflowPlanError(`Step "${step.id}" failed after compaction retry (${String(error)})`);
          case "fail":
          default:
            throw error;
        }
      }
    }
    throw new Error(`Step "${step.id}" exhausted retries`);
  }

  private async runWithModelFallback(
    state: ExecutionState,
    step: WorkflowStep,
    worker: WorkflowWorkerDefinition,
    originalError: unknown,
  ): Promise<WorkflowStepOutput> {
    try {
      const input = await this.resolveStepInput(state, step);
      const agent = this.createAgent({
        systemPrompt: step.worker.systemPrompt ?? worker.systemPrompt,
        allowedTools: step.worker.allowedTools ?? worker.allowedTools,
        model: this.fallbackModel,
      });
      try {
        return await agent.prompt(input);
      } finally {
        agent.destroy();
      }
    } catch (fallbackError) {
      throw new WorkflowPlanError(
        `Step "${step.id}" failed with ${this.fallbackModel} fallback: ${String(fallbackError)} (original: ${String(originalError)})`,
      );
    }
  }

  private async resolveStepInput(state: ExecutionState, step: WorkflowStep): Promise<string> {
    if (!step.input) return step.description ?? step.name;
    try {
      return resolveInputTemplate(
        step.input.template,
        step.input.references,
        state.stepOutputs,
        state.plan.context ?? {},
      );
    } catch (error) {
      if (error instanceof WorkflowInputError) {
        throw new WorkflowPlanError(`Step "${step.id}" input resolution failed: ${error.message}`);
      }
      throw error;
    }
  }

  private async awaitCheckpointDecision(
    state: ExecutionState,
    step: WorkflowStep,
    output: WorkflowStepOutput,
  ): Promise<WorkflowCheckpointDecision> {
    const planId = state.plan.id;
    // A pre-supplied decision (from resume()) short-circuits and is consumed
    // immediately — one decision per checkpoint, never reused downstream.
    const predecided = this.pausedDecisions.get(planId);
    if (predecided) {
      this.pausedDecisions.delete(planId);
      return predecided;
    }
    // Race the checkpoint handler against a resume()-delivered decision so a
    // paused execution can be resumed without re-entering the run loop.
    const waiter = new Promise<WorkflowCheckpointDecision>(resolve => {
      this.checkpointWaiters.set(planId, resolve);
    });
    try {
      return await Promise.race([this.checkpointHandler.waitForDecision(step, state.plan, output), waiter]);
    } catch (error) {
      if (error instanceof WorkflowCheckpointError) {
        this.logger?.warn(`Checkpoint handler unavailable for step "${step.id}", auto-approving`, {
          planId,
          error: error.message,
        });
        return { action: "approve" };
      }
      throw error;
    } finally {
      this.checkpointWaiters.delete(planId);
    }
  }

  private conditionContext(state: ExecutionState): Record<string, unknown> {
    // `{{context.*}}` resolves against the plan context; step outputs are
    // keyed by step id at the top level.
    return {
      context: state.plan.context ?? {},
      ...state.stepOutputs,
    } as unknown as Record<string, unknown>;
  }

  private getReadySteps(plan: WorkflowPlan): WorkflowStep[] {
    const done = (step: WorkflowStep): boolean => {
      const status = step.status;
      return status === "completed" || status === "skipped" || status === "failed";
    };
    return plan.steps.filter(step => {
      if (step.status !== "pending") return false;
      const deps = step.dependsOn ?? [];
      if (deps.length === 0) return true;
      return deps.every(depId => {
        const dep = plan.steps.find(candidate => candidate.id === depId);
        return dep ? done(dep) : true; // unknown dep treated as satisfied
      });
    });
  }

  private countStatuses(plan: WorkflowPlan): { completed: number; total: number } {
    let completed = 0;
    for (const step of plan.steps) {
      if (step.status === "completed" || step.status === "skipped") completed++;
    }
    return { completed, total: plan.steps.length };
  }

  /** Validate plan shape, dependency graph, worker existence and IDs. */
  private validatePlan(plan: WorkflowPlan): void {
    const ids = new Set<string>();
    for (const step of plan.steps) {
      if (ids.has(step.id)) throw new WorkflowPlanError(`Duplicate step id "${step.id}"`);
      ids.add(step.id);
      try {
        this.workerResolver.resolve(step.worker.name);
      } catch (error) {
        if (error instanceof WorkflowWorkerError) {
          throw new WorkflowPlanError(`Step "${step.id}" references unknown worker "${step.worker.name}"`);
        }
        throw error;
      }
    }
    // Cycle detection via DFS.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (step: WorkflowStep, chain: string[]): void => {
      if (visiting.has(step.id)) {
        throw new WorkflowPlanError(`Cyclic dependency detected: ${[...chain, step.id].join(" -> ")}`);
      }
      if (visited.has(step.id)) return;
      visiting.add(step.id);
      for (const depId of step.dependsOn ?? []) {
        if (!ids.has(depId)) continue; // unknown deps treated as satisfied
        const dep = plan.steps.find(candidate => candidate.id === depId)!;
        visit(dep, [...chain, step.id]);
      }
      visiting.delete(step.id);
      visited.add(step.id);
    };
    for (const step of plan.steps) {
      if (!visited.has(step.id)) visit(step, []);
    }
  }

  private emit(event: WorkflowEvent): void {
    this.eventSink?.emit(event);
  }
}
