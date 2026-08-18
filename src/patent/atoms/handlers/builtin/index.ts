/**
 * 内置 Pipeline 原子聚合（按职责分域，公共 LLM 骨架见 llm.ts）。
 *
 * - search.ts：search（检索）/ keywords（关键词生成）
 * - extract.ts：extract（结构化抽取）/ merge（PFE 融合）
 * - compare.ts：compare（特征对比）/ novelty（逐特征新颖性）
 * - reason.ts：reasoning（自由推理）/ groundedness（原文依据过滤）
 * - draft.ts：draft-claims（权利要求草稿）/ draft-spec（说明书草稿+校验）
 * - gate.ts：approval-gate（人机审批门）/ quality-gate（检索质量门槛）/ slop-gate（反套话评分门）
 * - chart.ts：claim-chart（要素级证据网格）
 */

export {
  searchAtom,
  SearchHandler,
  keywordsAtom,
  KeywordsHandler,
} from "./search.js";
export {
  extractAtom,
  ExtractHandler,
  mergeAtom,
  MergeHandler,
  type PFETriple,
} from "./extract.js";
export {
  compareAtom,
  CompareHandler,
  noveltyAtom,
  NoveltyHandler,
  evidenceCoverage,
} from "./compare.js";
export {
  reasoningAtom,
  ReasoningHandler,
  groundednessAtom,
  GroundednessHandler,
  GROUNDEDNESS_THRESHOLD,
} from "./reason.js";
export {
  draftClaimsAtom,
  DraftClaimsHandler,
  draftSpecAtom,
  DraftSpecHandler,
  validateDraftSpec,
  type SpecViolation,
} from "./draft.js";
export {
  approvalGateAtom,
  ApprovalGateHandler,
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_OUTPUT,
  isApprovalGateHandler,
  qualityGateAtom,
  QualityGateHandler,
  slopGateAtom,
  SlopGateHandler,
} from "./gate.js";
export { claimChartAtom, ClaimChartHandler } from "./chart.js";
