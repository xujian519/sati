/**
 * src/patent/evaluate — 专利评估框架 barrel。
 *
 * - metrics：确定性指标（关键词召回/法条引文完整/规则门判级/Jaccard）；
 * - evaluator：统一评估器（CaseRunner + 指标汇总 + BatchReport）；
 * - llm-judge：LLM Rubric Judge（N 采样取中位数）；
 * - runner：图引擎评测运行器（领域子图自动执行 + 规则门收口）。
 */

export {
  extractKeywords,
  keywordRecall,
  citationCompleteness,
  ruleGatePass,
  jaccardSimilarity,
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
export { llmJudge, parseJudgeScore, type LlmJudgeOptions, type LlmJudgeClient } from "./llm-judge.js";
export {
  createGraphRunner,
  defaultDomainGraphMap,
  evaluateSingleText,
  type GraphRunnerOptions,
} from "./runner.js";
