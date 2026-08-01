/**
 * Workflow module — DAG-based workflow orchestration engine.
 *
 * Adapted from XiaoNuo Agent's `packages/agent-core/src/workflow/` (engine,
 * dag-engine, input-resolver, safe-evaluator, worker-resolver, persistence),
 * stripped of Nuo-specific dependencies.
 */

export type {
  WorkflowPlanStatus,
  WorkflowStepStatus,
  WorkflowFailureStrategy,
  WorkflowStepOutput,
  WorkflowStepInput,
  WorkflowCheckpointConfig,
  WorkflowStepCondition,
  WorkflowStep,
  WorkflowWorkerConfig,
  WorkflowPlan,
  WorkflowWorkerDefinition,
  WorkflowAgentFactory,
  WorkflowRetryPolicy,
  WorkflowCheckpointDecision,
  WorkflowCheckpointHandler,
  WorkflowEvent,
  WorkflowEventSink,
  WorkflowPlanAdjustment,
  WorkflowPlanStatusSnapshot,
} from "./protocol/types.js";

export {
  WorkflowEngine,
  WorkflowPlanError,
  type WorkflowEngineOptions,
} from "./runtime/WorkflowEngine.js";
export {
  WorkflowConditionError,
  evaluateConditionExpression,
  type WorkflowConditionContext,
} from "./runtime/SafeEvaluator.js";
export {
  WorkflowInputError,
  resolveInputTemplate,
  type WorkflowStepOutputs,
} from "./runtime/InputResolver.js";
export {
  FlowGraph,
  DagExecutor,
  type FlowNode,
  type FlowNodeType,
  type FlowEdge,
  type DagExecutorOptions,
  type DagExecutionResult,
} from "./runtime/DagEngine.js";
export {
  createSubagentWorkflowAgentFactory,
  type SubagentWorkflowAgentFactoryOptions,
} from "./runtime/SubagentWorkflowAgentFactory.js";
export { WorkflowWorkerError, WorkflowWorkerResolver } from "./worker/WorkerResolver.js";
export {
  NoopCheckpointHandler,
  WorkflowCheckpointError,
} from "./checkpoint/CheckpointHandler.js";
export {
  InMemoryWorkflowPlanStore,
  JsonFileWorkflowPlanStore,
  type WorkflowPlanStore,
} from "./persistence/WorkflowPlanStore.js";
