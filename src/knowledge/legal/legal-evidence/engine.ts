/**
 * 法律域证据判断引擎。
 *
 * 对单条法定证据做三性判定（关联性/合法性/真实性）+ 类型特定检查，输出加权综合分
 * 与规则检查发现。判定是确定性的（无 LLM）；权重可经
 * `rules/legal/legal-evidence-rules.yaml` 配置，资产缺失时回退默认权重。
 */

import { getLegalEvidenceEvaluator } from "./evaluators.js";
import { DEFAULT_LEGAL_WEIGHTS, parseLegalRuleSet } from "./rule-set.js";
import type {
  LegalEvidenceAssessment,
  LegalEvidenceRule,
  LegalEvidenceRuleSet,
  LegalEvidenceScore,
  LegalEvidenceType,
  LegalEvidenceInput,
} from "./types.js";

/** 法律域证据引擎。 */
export class LegalEvidenceEngine {
  private ruleSet: LegalEvidenceRuleSet | null = null;
  private readonly warnings: string[] = [];

  constructor(yamlText?: string, source = "<inline>") {
    if (yamlText !== undefined) this.loadRules(yamlText, source);
  }

  /** 加载 YAML 规则资产（解析失败时保持默认权重，不抛错）。 */
  loadRules(yamlText: string, source = "<inline>"): void {
    const parsed = parseLegalRuleSet(yamlText, source);
    this.warnings.push(...parsed.warnings);
    if (parsed.ruleSet !== null) this.ruleSet = parsed.ruleSet;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  getRules(): LegalEvidenceRule[] {
    return [...(this.ruleSet?.rules ?? [])];
  }

  getRulesByType(evidenceType: LegalEvidenceType): LegalEvidenceRule[] {
    return (this.ruleSet?.rules ?? []).filter(r => r.evidenceType === evidenceType || r.evidenceType === "general");
  }

  private get weights(): { relevance: number; legality: number; authenticity: number } {
    return this.ruleSet?.weights ?? DEFAULT_LEGAL_WEIGHTS;
  }

  /** 对单条证据做三性判定。 */
  assess(input: LegalEvidenceInput): LegalEvidenceAssessment {
    const evaluator = getLegalEvidenceEvaluator(input.evidenceType);
    const relevance = evaluator.evaluateRelevance(input);
    const legality = evaluator.evaluateLegality(input);
    const authenticity = evaluator.evaluateAuthenticity(input);
    const findings = evaluator.checkFindings(input);
    const score = this.computeOverallScore(relevance.score, legality.score, authenticity.score);
    return {
      evidenceId: input.evidenceId,
      evidenceType: input.evidenceType,
      score,
      dimensions: { relevance, legality, authenticity },
      findings,
      ...(input.burdenHolder !== undefined ? { burdenHolder: input.burdenHolder } : {}),
      ...(input.standard !== undefined ? { standard: input.standard } : {}),
      reasoning: this.buildReasoning(relevance, legality, authenticity, findings),
    };
  }

  /** 批量判定。 */
  batchAssess(inputs: LegalEvidenceInput[]): LegalEvidenceAssessment[] {
    return inputs.map(input => this.assess(input));
  }

  private computeOverallScore(relevance: number, legality: number, authenticity: number): LegalEvidenceScore {
    const weights = this.weights;
    const overall = relevance * weights.relevance + legality * weights.legality + authenticity * weights.authenticity;
    return {
      relevance,
      legality,
      authenticity,
      overall: Math.max(0, Math.min(1, Number(overall.toFixed(3)))),
    };
  }

  private buildReasoning(
    relevance: LegalEvidenceAssessment["dimensions"]["relevance"],
    legality: LegalEvidenceAssessment["dimensions"]["legality"],
    authenticity: LegalEvidenceAssessment["dimensions"]["authenticity"],
    findings: LegalEvidenceAssessment["findings"],
  ): string {
    const parts: string[] = [
      `关联性[${relevance.level}]: ${relevance.reasoning}`,
      `合法性[${legality.level}]: ${legality.reasoning}`,
      `真实性[${authenticity.level}]: ${authenticity.reasoning}`,
    ];
    const critical = findings.filter(f => !f.passed && f.severity === "critical");
    if (critical.length > 0) {
      parts.push(`存在 ${critical.length} 项严重问题：${critical.map(f => f.reason).join("；")}`);
    }
    return parts.join("; ");
  }
}
