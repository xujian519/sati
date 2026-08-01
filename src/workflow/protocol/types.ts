/**
 * Workflow protocol types — the type contract for the DAG workflow engine.
 *
 * Adapted from XiaoNuo Agent's `packages/agent-core/src/workflow/types.ts`,
 * stripped of Nuo-specific dependencies (`ReasoningStrategyConfig`,
 * `BaseAgentDefinition`, `SceneCategory`). A workflow plan is a DAG of steps;
 * each step runs a named worker (a subagent) with an input template resolved
 * from upstream step outputs.
 */

export type WorkflowPlanStatus = "draft" | "running" | "paused" | "completed" | "failed" | "contract_blocked";

export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "contract_blocked";

/** Step-level failure strategies, in escalating order of leniency. */
export type WorkflowFailureStrategy =
  | "fail" // default — mark the plan failed
  | "skip" // mark this step skipped, continue downstream
  | "default" // fill with defaultValue
  | "model_fallback" // retry once with the fallback model
  | "compact_and_retry"; // retry with input compacted to 50%

export type WorkflowStepOutput = {
  /** Markdown/text summary produced by the step. */
  summary: string;
  /** Structured data, addressable as `{{stepId.output.data.field}}`. */
  data?: Record<string, unknown>;
  /** File paths or artifact references produced by the step. */
  artifacts?: string[];
};

export type WorkflowStepInput = {
  /** Template string with `{{path}}` placeholders. */
  template: string;
  /**
   * Alias map for placeholders, e.g. `{ previous: "step1.output.summary" }`
   * lets the template use `{{previous}}`. Resolved before direct paths.
   */
  references?: Record<string, string>;
};

export type WorkflowCheckpointConfig = {
  title: string;
  allowEdit?: boolean;
  allowSkip?: boolean;
};

export type WorkflowStepCondition = {
  /** Safe boolean expression over `{{stepId.status}}` / `{{stepId.output.data.*}}`. */
  expression: string;
  description?: string;
};

export type WorkflowStep = {
  id: string;
  name: string;
  description?: string;
  worker: WorkflowWorkerConfig;
  input?: WorkflowStepInput;
  checkpoint?: WorkflowCheckpointConfig;
  dependsOn?: string[];
  condition?: WorkflowStepCondition;
  status: WorkflowStepStatus;
  output?: WorkflowStepOutput;
};

export type WorkflowWorkerConfig = {
  name: string;
  /** Overrides the worker definition's system prompt. */
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
  /** Step-level failure strategy; falls back to the worker definition. */
  onFailure?: WorkflowFailureStrategy;
  defaultValue?: WorkflowStepOutput;
};

export type WorkflowPlan = {
  id: string;
  intent: string;
  steps: WorkflowStep[];
  status: WorkflowPlanStatus;
  context?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Full worker definition, registered with the {@link WorkflowWorkerResolver}.
 * The engine resolves `step.worker.name` against these when running a step.
 */
export type WorkflowWorkerDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string;
  onFailure?: WorkflowFailureStrategy;
  defaultValue?: WorkflowStepOutput;
};

/**
 * Factory contract the engine uses to run a single step. Sati implements this
 * by bridging to `SubAgentSession` (see `src/workflow/runtime/SubagentAgentFactory.ts`).
 */
export type WorkflowAgentFactory = (config: { systemPrompt: string; allowedTools?: string[]; model?: string }) => {
  prompt: (input: string, signal?: AbortSignal) => Promise<WorkflowStepOutput>;
  destroy: () => void;
};

export type WorkflowRetryPolicy = {
  maxRetries: number;
  /** Base delay between retries. Default 1_000ms. */
  delayMs?: number;
  /** When true, delay = delayMs * 2^attempt. */
  exponentialBackoff?: boolean;
};

/** Human-in-the-loop decisions at a checkpoint. */
export type WorkflowCheckpointDecision =
  | { action: "approve"; feedback?: string }
  | { action: "reject"; feedback?: string }
  | { action: "edit"; feedback?: string; editedOutput?: WorkflowStepOutput }
  | { action: "skip"; feedback?: string };

export interface WorkflowCheckpointHandler {
  waitForDecision(
    step: WorkflowStep,
    plan: WorkflowPlan,
    output: WorkflowStepOutput,
  ): Promise<WorkflowCheckpointDecision>;
}

export type WorkflowEvent =
  | { type: "workflow_started"; planId: string }
  | { type: "step_started"; planId: string; stepId: string }
  | { type: "step_completed"; planId: string; stepId: string }
  | { type: "step_failed"; planId: string; stepId: string; error: string }
  | { type: "step_skipped"; planId: string; stepId: string }
  | { type: "checkpoint_reached"; planId: string; stepId: string }
  | { type: "checkpoint_decided"; planId: string; stepId: string; action: string }
  | { type: "workflow_completed"; planId: string }
  | { type: "workflow_failed"; planId: string; error?: string }
  | { type: "workflow_paused"; planId: string };

export interface WorkflowEventSink {
  emit(event: WorkflowEvent): void;
}

/** Runtime adjustments applied to a plan (add / remove / reorder / modify). */
export type WorkflowPlanAdjustment =
  | { type: "add_step"; afterStepId?: string; step: Omit<WorkflowStep, "id" | "status"> & { id: string } }
  | { type: "remove_step"; stepId: string }
  | { type: "reorder"; stepIds: string[] }
  | { type: "modify_step"; stepId: string; modifications: Partial<Omit<WorkflowStep, "id" | "status">> };

export type WorkflowPlanStatusSnapshot = {
  planId: string;
  status: WorkflowPlanStatus;
  stepStatuses: Record<string, WorkflowStepStatus>;
  updatedAt: Date;
};
