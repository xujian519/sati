/**
 * src/patent/evaluate — 统一评估器（对齐 Mady evaluate/evaluator.go）。
 *
 * 把"跑图/单文本 + 规则门"封装为可插拔 CaseRunner，逐用例产出指标并汇总 BatchReport。
 * 指标函数按名注册（keyword_recall / citation_completeness / rule_gate_pass / jaccard）。
 */

import { citationCompleteness, jaccardSimilarity, keywordRecall, ruleGatePass } from "./metrics.js";

/** 单条评测用例（对齐 tests/patent/benchmark/types.ts 的 PatentExamCase 子集）。 */
export type EvalCase = {
  id: string;
  domain: string;
  input: string;
  expected: string;
  requiredCitations?: string[];
  /** 业务类型（business fixture 附加；用于图选择）。 */
  businessTask?: string;
};

/** 单条用例运行结果。 */
export type EvalOutcome = {
  caseId: string;
  /** 产出文本（图模式为报告聚合；单文本模式为 LLM 输出）。 */
  output: string;
  /** 命名指标 → 0-1 分数。 */
  metrics: Record<string, number>;
  /** 规则门失败 ruleId 列表（空 = 全部通过）。 */
  ruleGateFailures: string[];
  /** 规则门判级（pass/needs_revision/blocked）。 */
  verdict: string;
  /** 是否降级（图模式：任一节点降级）。 */
  degraded: boolean;
  elapsedMs: number;
};

/** 用例运行器：输入 → 产出 + 规则门信息。 */
export type CaseRunner = (
  input: string,
  caseMeta: EvalCase,
) => Promise<{ output: string; ruleGateFailures: string[]; verdict: string; degraded: boolean }>;

/** 批次报告。 */
export type BatchReport = {
  total: number;
  /** 达标用例数（综合分 ≥ passLine）。 */
  passed: number;
  /** 各指标批次均值。 */
  metrics: Record<string, number>;
  /** 降级用例数。 */
  degradedCount: number;
  cases: EvalOutcome[];
};

/** 指标计算输入（最小接口：指标函数只依赖这些字段）。 */
export type MetricInput = {
  expected: string;
  output: string;
  verdict: string;
  required?: readonly string[];
};

/** 内置指标注册表（名 → 计算函数）。 */
export const DEFAULT_METRICS: Record<string, (outcome: MetricInput) => number> = {
  keyword_recall: outcome => keywordRecall(outcome.expected, outcome.output),
  citation_completeness: outcome => citationCompleteness(outcome.output, outcome.required ?? []),
  rule_gate_pass: outcome => ruleGatePass(outcome.verdict),
  jaccard: outcome => jaccardSimilarity(outcome.expected, outcome.output),
};

export type EvaluatorOptions = {
  /** 指标计算函数表（缺省 DEFAULT_METRICS）。 */
  metrics?: Record<string, (outcome: MetricInput) => number>;
  /** 达标综合分（缺省 0.7，对齐 Mady 默认阈值）。 */
  passLine?: number;
};

export class Evaluator {
  private readonly metrics: Record<string, (outcome: MetricInput) => number>;
  private readonly passLine: number;

  constructor(
    private readonly runner: CaseRunner,
    options: EvaluatorOptions = {},
  ) {
    this.metrics = options.metrics ?? { ...DEFAULT_METRICS };
    this.passLine = options.passLine ?? 0.7;
  }

  /** 逐用例运行并汇总。 */
  async evaluateCases(cases: EvalCase[]): Promise<BatchReport> {
    const outcomes: EvalOutcome[] = [];
    for (const c of cases) {
      const started = Date.now();
      const run = await this.runner(c.input, c);
      const metricInput: MetricInput = {
        expected: c.expected,
        output: run.output,
        verdict: run.verdict,
        required: c.requiredCitations,
      };
      const metrics: Record<string, number> = {};
      for (const [name, fn] of Object.entries(this.metrics)) {
        metrics[name] = round3(fn(metricInput));
      }
      outcomes.push({
        caseId: c.id,
        output: run.output,
        metrics,
        ruleGateFailures: run.ruleGateFailures,
        verdict: run.verdict,
        degraded: run.degraded,
        elapsedMs: Date.now() - started,
      });
    }
    const metricNames = Object.keys(this.metrics);
    const averages: Record<string, number> = {};
    for (const name of metricNames) {
      averages[name] = round3(mean(outcomes.map(o => o.metrics[name] ?? 0)));
    }
    const overall = metricNames.length > 0 ? mean(outcomes.map(o => mean(metricNames.map(n => o.metrics[n] ?? 0)))) : 0;
    return {
      total: outcomes.length,
      passed: outcomes.filter(o => overallOf(o, metricNames) >= this.passLine).length,
      metrics: averages,
      degradedCount: outcomes.filter(o => o.degraded).length,
      cases: outcomes,
    };
  }
}

function overallOf(outcome: EvalOutcome, metricNames: string[]): number {
  if (metricNames.length === 0) return 0;
  return mean(metricNames.map(n => outcome.metrics[n] ?? 0));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
