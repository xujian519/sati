/**
 * src/patent — 专利域模块 barrel。
 *
 * - output-gate / quality-gate：输出门禁（HITL 审批挂起 + 质量门禁）——外部消费者
 *   统一从本 barrel 导入，勿深路径直入内部文件；声明式规则镜像：
 *   rules/patent/compliance.yaml 与本模块的关键词表互为镜像（改词需两处同步，注释互指）。
 * - workflow：声明式工作流执行器（内置 patentNoveltyManifest 五阶段新颖性分析）
 * - flexible-plan：灵活计划层（阶段级生命周期管理：增删改阶段/逐阶段确认/
 *   回退重做/法条判定挂接，toManifest 交 runWorkflow 执行）
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
  CASE_ROOT_REL,
  CASE_OUTPUTS_REL,
  CASE_WORKFLOW_RUNS_REL,
  caseOutputsDir,
  caseWorkflowRunsDir,
} from "./paths.js";

export {
  type WorkflowStage,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowRunResult,
  type WorkflowRunOptions,
  type WorkflowRunStore,
  type WorkflowInterrupt,
  WorkflowError,
  validateWorkflowManifest,
  runWorkflow,
  patentNoveltyManifest,
  patentDisclosureManifest,
  patentInventivenessManifest,
  builtinPatentManifests,
  type BuiltinPatentManifest,
} from "./workflow.js";

export {
  manifestToFlowGraph,
  validateWorkflowManifestDag,
  workflowManifestToMermaid,
} from "./workflow-dag.js";

export {
  FlexiblePlanError,
  createFlexiblePlan,
  addStage,
  removeStage,
  reorderStages,
  confirmStage,
  rollbackStage,
  attachArticleJudgment,
  toManifest,
  complete,
  abandon,
  toJSON,
  fromJSON,
  type FlexibleStageStatus,
  type FlexibleStage,
  type FlexiblePlanStatus,
  type FlexiblePlanState,
  type CreateFlexiblePlanOptions,
} from "./flexible-plan.js";
export {
  type FlexiblePlanStore,
  JsonFileFlexiblePlanStore,
} from "./flexible-plan-store.js";

export {
  InMemoryWorkflowRunStore,
  JsonFileWorkflowRunStore,
} from "./workflow-store.js";

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
  EvidenceEngine,
  inferEvidenceType,
  evaluateFourElements,
  STANDARD_PREPONDERANCE,
  STANDARD_CLEAR_CONVINCING,
  loadEvidenceRulesEngine,
  platformCredibility,
  credibilityToScore,
  platformCategory,
  evaluatePublicIntent,
  parseDateFlexible,
  isPreciseDate,
  isMonthOnlyDate,
  inferredMonthEnd,
  extractDateFromText,
  isBeforeFilingDate,
  determinePublicationDate,
  extractWaybackMachineDate,
  cleanEvidenceURI,
} from "./evidence/index.js";
export type {
  EvidenceJudgment,
  DimensionJudgment,
  TypeSpecificJudgment,
  BurdenDetermination,
  ProofStandardResult,
  EvidenceRule,
  EvidenceRuleSet,
  EvidenceType,
  CredibilityLevel,
  DateDetermination,
  FourElementsResult,
  EvidenceExternalInputs,
  EvidenceJudgmentEngine,
  RuleApplication,
} from "./evidence/types.js";

export {
  analyzeSlop,
  detectStructureIssues,
  formatSlopAnalysis,
  runChecklist,
  runeSlice,
  scoreDocument,
  type SlopAnalysis,
  type SlopChange,
  type SlopGroup,
  type SlopScore,
  type StructureIssue,
  type StructureIssueType,
  type ChecklistItem,
} from "./slop-engine.js";

export {
  FactBlackboard,
  ConfirmedRuleSet,
  SyllogismBuilder,
  SyllogismError,
  ruleAssertion,
  assertChain,
  type FactEntry,
  type FactCategory,
  type RuleConstraint,
  type Requirement,
  type RuleConfirmation,
  type ConfirmedRuleEntry,
  type ArticleJudgment,
  type ReasoningChain,
  type ReasoningChainNode,
  type FactBlackboardOptions,
  type Syllogism,
  type Premise,
  type PremiseSource,
} from "./reasoning/index.js";

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
  groundednessAtom,
  GroundednessHandler,
  GROUNDEDNESS_THRESHOLD,
  keywordsAtom,
  KeywordsHandler,
  noveltyAtom,
  NoveltyHandler,
  evidenceCoverage,
  mergeAtom,
  MergeHandler,
  draftClaimsAtom,
  DraftClaimsHandler,
  type PFETriple,
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
  WORKER_ROLE_MAP,
} from "./worker-contract.js";

export {
  RuleEngine,
  aggregate,
  formatRuleResults,
  matchKeyword,
  matchKeywordsAll,
  matchKeywordsAny,
  defaultPatentRules,
  noveltyRules,
  inventivenessRules,
  disclosureRules,
  infringementRules,
  invalidationRules,
  reexaminationRules,
  specRules,
  designRules,
  priorityRules,
  publicAccessRules,
  subjectMatterRules,
  type CheckRule,
  type CheckType,
  type RuleCheckResult,
  type RuleEngineOptions,
  type RuleLevel,
  type Severity,
  type Verdict,
} from "./checker/index.js";
