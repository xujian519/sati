/**
 * 专利域执行模块 barrel export。
 *
 * - workflow：声明式工作流执行器（内置 patentNoveltyManifest 五阶段新颖性分析）
 * - plantask：人机协作计划状态机（HITL 闭环：planning→approval→executing→feedback→replanning）
 * - worker-contract：Worker 契约注册表与输出校验（defaultPatentWorkers 内置目录）
 * - quality-gate / output-gate：专利质量门禁与输出审批（见 src/patent）
 */

export {
  type WorkflowStrategy,
  type WorkflowStage,
  type WorkflowManifest,
  type WorkflowContext,
  type StageExecutor,
  type WorkflowStageResult,
  type WorkflowRunResult,
  WorkflowError,
  validateWorkflowManifest,
  runWorkflow,
  patentNoveltyManifest,
} from "./workflow.js";

export {
  type PlanTaskState,
  type PlanTaskStatus,
  type PlanTask,
  type PlanTaskSyncResult,
  TRANSITIONS,
  PlanTaskStateError,
  PlanTaskStateMachine,
  hashStep,
  syncPlanToTasks,
  replanTasks,
} from "./plantask.js";

export {
  type WorkerTier,
  type ContractLevel,
  type WorkerInputContract,
  type WorkerOutputContract,
  type WorkerContract,
  type WorkerOutputValidation,
  type WorkerExecutionRecord,
  TIER_LABELS,
  WorkerRegistryError,
  WorkerRegistry,
  validateWorkerOutput,
  WorkerMonitor,
  defaultPatentWorkers,
} from "./worker-contract.js";
