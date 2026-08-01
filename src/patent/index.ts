/**
 * src/patent — 专利域模块 barrel。
 *
 * - output-gate / quality-gate：输出门禁（HITL 审批挂起 + 质量门禁）——外部消费者
 *   统一从本 barrel 导入，勿深路径直入内部文件；声明式规则镜像：
 *   rules/patent/compliance.yaml 与本模块的关键词表互为镜像（改词需两处同步，注释互指）。
 * - workflow：声明式工作流执行器（内置 patentNoveltyManifest 五阶段新颖性分析）
 * - plantask：人机协作计划状态机（HITL 闭环：planning→approval→executing→feedback→replanning）
 * - worker-contract：Worker 契约注册表与输出校验（defaultPatentWorkers 内置目录）
 */

export { PatentOutputGate } from "./output-gate.js";
export type {
  PendingPatentMessage,
  PatentOutputGateOptions,
  ProcessedMessageResult,
} from "./output-gate.js";
export { extractMessageText } from "./output-gate.js";
export {
  ABSOLUTE_PHRASES,
  PATENT_APPROVAL_KEYWORDS,
  PATENT_DISCLAIMER,
  PATENT_RISK_KEYWORDS,
  processPatentOutput,
  verifyCitations,
  formatCitationWarnings,
} from "./quality-gate.js";
export type {
  CitationReport,
  FlaggedCitation,
  PatentQualityGateOptions,
  QualityGateResult,
} from "./quality-gate.js";

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
