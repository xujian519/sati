/**
 * src/patent/evaluate — 图引擎评测运行器。
 *
 * 把"领域子图自动执行 + 规则门收口"包装为 Evaluator 的 CaseRunner：
 * - 按用例映射到领域子图（defaultDomainGraphMap），跑图产出聚合文本 + 规则门 verdict；
 * - 无法映射（如 A31/A33 等未建图法条）时降级为单文本规则门（对齐 patent-eval.mjs 基线）。
 */

import { RuleEngine, aggregate, defaultPatentRules } from "../checker/index.js";
import { DOMAIN_GRAPHS, type DomainGraphName } from "../graph/domains/index.js";
import { collectStateText } from "../graph/domains/shared.js";
import type { StageHandlerRegistry, StageProvider } from "../atoms/index.js";
import { globalStageHandlerRegistry, registerBuiltinAtoms } from "../atoms/index.js";
import type { CaseRunner, EvalCase } from "./evaluator.js";

export type GraphRunnerOptions = {
  provider: StageProvider;
  handlers?: StageHandlerRegistry;
  /** 用例 → 领域子图映射（缺省 defaultDomainGraphMap）。 */
  graphMap?: (caseMeta: EvalCase) => DomainGraphName | undefined;
  /** fallback（未映射用例）规则门域；缺省全部规则。 */
  fallbackDomains?: readonly string[];
};

/**
 * 评测用 handler 注册表：确保内置原子已注册（registerBuiltinAtoms 幂等），
 * 且不含审批门 —— 评测要自动执行到 rule_gate 收口，不能停在 HITL 审批门。
 */
function evalHandlers(): StageHandlerRegistry {
  registerBuiltinAtoms();
  return globalStageHandlerRegistry;
}

/** 缺省用例 → 图映射（按 caseId/businessTask/expected 关键词）。 */
export function defaultDomainGraphMap(caseMeta: EvalCase): DomainGraphName | undefined {
  const id = caseMeta.id.toLowerCase();
  const task = (caseMeta.businessTask ?? "").toLowerCase();
  const expected = (caseMeta.expected ?? "").toLowerCase();
  if (task.includes("novelty") || id.includes("novelty")) return "novelty";
  if (task.includes("disclosure") || id.includes("a26") || id.includes("disclosure")) return "enablement";
  // 法条精确判别（A22.2 新颖性 / A22.3 创造性）优先于宽松 a22 前缀。
  if (id.includes("a22.2") || id.includes("a22_2")) return "novelty";
  if (id.includes("a22.3") || id.includes("a22_3")) return "inventiveness";
  // expected 语义兜底：真题 id 常只有 "a22"（无 .2/.3），按答案要旨判别
  // （如 2010 真题 "不具备新颖性" 不得误入创造性三步法图）。
  if (expected.includes("新颖")) return "novelty";
  if (expected.includes("创造")) return "inventiveness";
  if (task.includes("patentability") || id.includes("a22") || id.includes("inventiveness")) return "inventiveness";
  return undefined;
}

/** 单文本规则门评估（未映射用例 fallback）。 */
export function evaluateSingleText(
  text: string,
  domains: readonly string[] = [],
): { verdict: string; failures: string[] } {
  const engine = new RuleEngine();
  engine.registerMany(defaultPatentRules());
  const results = engine.evaluate(text, { domain: domains });
  return { verdict: aggregate(results), failures: results.map(r => r.ruleId) };
}

/** 图引擎评测运行器。 */
export function createGraphRunner(options: GraphRunnerOptions): CaseRunner {
  const handlers = options.handlers ?? evalHandlers();
  const graphMap = options.graphMap ?? defaultDomainGraphMap;
  return async (input: string, caseMeta: EvalCase) => {
    const graphName = graphMap(caseMeta);
    if (graphName === undefined) {
      // 单文本 fallback：LLM 输出即规则门输入（调用方已先做 LLM 生成时使用）。
      const { verdict, failures } = evaluateSingleText(input, options.fallbackDomains ?? []);
      return { output: input, ruleGateFailures: failures, verdict, degraded: false };
    }
    const def = DOMAIN_GRAPHS[graphName];
    // includeApproval: false —— 评测自动执行到 rule_gate 收口，不停 HITL 审批门。
    const graph = def.build({ handlers, includeApproval: false }).compile(def.entry);
    const result = await graph.run(
      { text: input, claim: input, source_text: input, extraction_input: input },
      { provider: options.provider },
    );
    const verdict = typeof result.state.rule_gate_verdict === "string" ? result.state.rule_gate_verdict : "blocked";
    const failures = Array.isArray(result.state.rule_gate_failures) ? result.state.rule_gate_failures.map(String) : [];
    return {
      output: collectStateText(result.state),
      ruleGateFailures: failures,
      verdict,
      degraded: result.degraded.length > 0,
    };
  };
}
