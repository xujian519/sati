/**
 * src/patent/evaluate — 专利评估框架 barrel。
 *
 * - metrics：确定性指标（关键词召回/法条引文完整/规则门判级/Jaccard）；
 * - evaluator：统一评估器（CaseRunner + 指标汇总 + BatchReport）；
 * - llm-judge：LLM Rubric Judge（N 采样取中位数；多 judge 投票见 collectJudgeVotes）；
 * - consensus：多模型共识判定 + Verdict Envelope（typed verdict 审计，三层：
 *   机械 → 语义 → 共识）；
 * - runner：图引擎评测运行器（领域子图自动执行 + 规则门收口）。
 */

export {
  extractKeywords,
  keywordRecall,
  citationCompleteness,
  ruleGatePass,
  jaccardSimilarity,
  conclusionDirection,
  extractDirection,
  extractActualDirection,
} from "./metrics.js";
export {
  Evaluator,
  DEFAULT_METRICS,
  type EvalCase,
  type EvalOutcome,
  type CaseRunner,
  type BatchReport,
  type EvaluatorOptions,
} from "./evaluator.js";
export {
  llmJudge,
  collectJudgeVotes,
  parseJudgeScore,
  type LlmJudgeOptions,
  type LlmJudgeClient,
  type NamedJudge,
  type JudgeVoteOptions,
} from "./llm-judge.js";
export {
  resolveConsensus,
  buildVerdictEnvelope,
  verifyVerdictEnvelope,
  renderConsensusText,
  compositeOverall,
  type JudgeVote,
  type ConsensusVerdict,
  type ConsensusOptions,
  type VerdictLayer,
  type VerdictEnvelope,
} from "./consensus.js";
export {
  createGraphRunner,
  defaultDomainGraphMap,
  evaluateSingleText,
  type GraphRunnerOptions,
} from "./runner.js";
