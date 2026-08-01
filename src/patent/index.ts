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

export {
  PatentOutputGate,
  type PatentOutputGateOptions,
  type PendingPatentMessage,
  type ProcessedMessageResult,
} from "./output-gate.js";
export { ABSOLUTE_PHRASES } from "./quality-gate.js";
export {
  type ApprovalRecord,
  type ApprovalVerdict,
  type ApprovalStore,
  InMemoryApprovalStore,
  createApprovalRecord,
} from "./approval.js";

export {
  type WorkflowStage,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowRunResult,
  type WorkflowRunOptions,
  type WorkflowInterrupt,
  WorkflowError,
  validateWorkflowManifest,
  runWorkflow,
  patentNoveltyManifest,
} from "./workflow.js";

export {
  type EvidenceSpan,
  type EvidenceDirection,
  type EvidenceConflict,
  createSpan,
  isLocatable,
  Ledger,
  contentHash,
  receiptFromToolExecution,
  ClaimBinding,
  ConflictDetector,
  EvidenceExtension,
} from "./evidence/index.js";

export {
  type Atom,
  type AtomCategory,
  AtomRegistry,
  AtomRegistryError,
  globalAtomRegistry,
  RegisterAtom,
  LookupAtom,
  ListAtoms,
  ListAtomsByCategory,
  type PipelineState,
  type StageProvider,
  type StageExecuteInput,
  type StageHandler,
  StageError,
  InterruptStageError,
  isInterruptStageError,
  StageHandlerRegistry,
  globalStageHandlerRegistry,
  RegisterStageHandler,
  LookupStageHandler,
  registerBuiltinAtoms,
  searchAtom,
  SearchHandler,
  extractAtom,
  ExtractHandler,
  compareAtom,
  CompareHandler,
  reasoningAtom,
  ReasoningHandler,
  approvalGateAtom,
  ApprovalGateHandler,
} from "./atoms/index.js";

export {
  type PlanTaskState,
  type PlanTask,
  TRANSITIONS,
  PlanTaskStateMachine,
  syncPlanToTasks,
  replanTasks,
} from "./plantask.js";

export {
  WorkerRegistry,
  validateWorkerOutput,
  defaultPatentWorkers,
} from "./worker-contract.js";
