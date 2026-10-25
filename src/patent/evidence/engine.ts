/**
 * 证据判断引擎（移植自 Mady domains/evidence/engine.go + triple_attrs.go）。
 *
 * 对单条证据做三性判定（相关性/合法性/真实性）+ 类型特定判定（电子证据/
 * 互联网公开/域外/证人/公知常识/使用公开/现有技术日期），综合评分；
 * 并提供举证责任分配与证明标准达成评估。
 *
 * 设计对齐 Mady：确定性判定（无 LLM），权重可经 YAML 资产
 * （rules/patent/evidence-rules.yaml）配置；外部服务不可用时降级而非失败。
 *
 * 本文件只保留 EvidenceEngine 编排层（#722 拆分）：
 * - judgment.ts：三性单维评分与等级/权重常量
 * - type-inference.ts：证据类型推断与类型特定判定
 * - four-elements.ts：使用公开四要件
 * - rule-evaluation.ts：YAML 规则表解析与条件求值
 */

import type { EvidenceSpan } from "./span.js";
import {
  buildReasoning,
  computeOverallScore,
  DEFAULT_WEIGHTS,
  evaluateAuthenticity,
  evaluateLegality,
  evaluateRelevance,
} from "./judgment.js";
import { type ConditionContext, evaluateCondition, parseRuleSet } from "./rule-evaluation.js";
import { evaluateTypeSpecific, inferEvidenceType } from "./type-inference.js";
import type {
  BurdenDetermination,
  EvidenceExternalInputs,
  EvidenceJudgment,
  EvidenceJudgmentEngine,
  EvidenceRule,
  EvidenceType,
  JudgmentIssue,
  ProofStandardResult,
  RuleApplication,
} from "./types.js";

/** 证明标准标识。 */
export const STANDARD_PREPONDERANCE = "preponderance";
export const STANDARD_CLEAR_CONVINCING = "clear_and_convincing";

// ---------------------------------------------------------------------------
// DefaultEngine（对齐 Mady DefaultEngine）
// ---------------------------------------------------------------------------

/**
 * 默认证据判断引擎。RuleIndex 内联实现（加载 YAML 资产 → 规则表），
 * 资产缺失时降级为默认权重 + 空规则表（不抛错）。
 */
export class EvidenceEngine implements EvidenceJudgmentEngine {
  private weights = { ...DEFAULT_WEIGHTS };
  private rules: EvidenceRule[] = [];
  private readonly warnings: string[] = [];

  constructor(yamlText?: string, source = "<inline>") {
    if (yamlText !== undefined) this.loadRules(yamlText, source);
  }

  loadRules(yamlText: string, source = "<inline>"): void {
    const { ruleSet, warnings } = parseRuleSet(yamlText, source);
    this.warnings.push(...warnings);
    if (ruleSet === null) return;
    this.weights = { ...ruleSet.weights };
    this.rules = ruleSet.rules;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  getRules(): EvidenceRule[] {
    return [...this.rules];
  }

  getRulesByType(evidenceType: EvidenceType): EvidenceRule[] {
    return this.rules.filter(r => r.evidenceType === evidenceType);
  }

  /** 对单条证据做三性 + 类型特定判定（evidenceType 显式指定时覆盖 URI 推断）。 */
  judge(
    span: EvidenceSpan,
    filingDate?: string,
    evidenceType?: EvidenceType,
    external: EvidenceExternalInputs = {},
  ): EvidenceJudgment {
    const evType = evidenceType ?? inferEvidenceType(span);
    const judgment: EvidenceJudgment = {
      spanId: span.id,
      confidence: 0.5,
      overallScore: 0.5,
      reasoning: "",
      flaggedIssues: [],
      rulesApplied: [],
    };

    judgment.relevanceJudgment = evaluateRelevance(span);
    judgment.legalityJudgment = evaluateLegality(span);
    judgment.authenticityJudgment = evaluateAuthenticity(span);

    const issues: JudgmentIssue[] = [];
    if (judgment.relevanceJudgment.score < 0.5) {
      issues.push({ type: "relevance", description: "相关性不足", severity: "major" });
    }
    if (judgment.legalityJudgment.score < 0.5) {
      issues.push({ type: "legality", description: "合法性存疑", severity: "critical" });
    }
    if (judgment.authenticityJudgment.score < 0.3) {
      issues.push({ type: "authenticity", description: "真实性无法确认", severity: "critical" });
    }
    judgment.flaggedIssues = issues;

    judgment.typeSpecificJudgment = evaluateTypeSpecific(span, evType, filingDate);
    judgment.overallScore = computeOverallScore(judgment, this.weights);
    // confidence 与评分关联（低分证据不应宣称"确信"）——固定 1.0 是误导。
    judgment.confidence = Number(judgment.overallScore.toFixed(3));
    judgment.rulesApplied = this.applyRules(span, evType, filingDate, external);
    judgment.reasoning = buildReasoning(judgment, evType);
    return judgment;
  }

  /** 批量判定。 */
  batchJudge(
    spans: EvidenceSpan[],
    filingDate?: string,
    evidenceType?: EvidenceType,
    external?: EvidenceExternalInputs,
  ): EvidenceJudgment[] {
    return spans.map(span => this.judge(span, filingDate, evidenceType, external));
  }

  /**
   * 规则表应用（evidence-rules.yaml）：每条匹配证据类型的规则，对其 check.conditions
   * 逐项评估——已知条件（span/日期可判）确定 true/false；外部输入条件（公证/译本等）
   * 未提供时标记 pending（不误判为失败）。满足全部条件的规则为实际适用（rulesMatched）。
   */
  private applyRules(
    span: EvidenceSpan,
    evType: EvidenceType,
    filingDate: string | undefined,
    external: EvidenceExternalInputs,
  ): RuleApplication[] {
    const ctx: ConditionContext = { span, filingDate, external };
    const applicable = this.rules.filter(r => r.evidenceType === evType || r.evidenceType === "general");
    return applicable.map(rule => {
      const conditions = rule.check?.conditions ?? [];
      const pendingInputs: string[] = [];
      const failedConditions: string[] = [];
      let allMet = true;
      for (const condition of conditions) {
        const result = evaluateCondition(condition, ctx);
        if (result === undefined) {
          pendingInputs.push(condition);
        } else if (!result) {
          allMet = false;
          failedConditions.push(condition);
        }
      }
      return {
        ruleId: rule.ruleId,
        name: rule.name,
        action: rule.action,
        severity: rule.severity,
        // 有 pending 条件的规则不算实际适用（需外部输入确认后才 satisfied）
        satisfied: allMet && pendingInputs.length === 0,
        pendingInputs,
        failedConditions,
      };
    });
  }

  /** 举证责任分配（caseType: invalidation / infringement / new_product_method 等）。 */
  assessBurdenOfProof(caseType: string, context?: Record<string, string>): BurdenDetermination {
    const det: BurdenDetermination = {
      burdenHolder: "claimant",
      standard: STANDARD_PREPONDERANCE,
      hasShifted: false,
      reasoning: "适用谁主张谁举证原则",
    };
    switch (caseType.toLowerCase()) {
      case "invalidation":
      case "invalidity":
      case "无效":
        det.burdenHolder = "claimant";
        det.reasoning = "无效宣告程序中，请求人对其主张承担举证责任";
        break;
      case "infringement":
      case "侵权":
        det.burdenHolder = "claimant";
        det.standard = STANDARD_CLEAR_CONVINCING;
        det.reasoning = "侵权诉讼中，权利人对其主张承担举证责任";
        break;
      case "new_product_method":
      case "新产品制造方法":
        det.burdenHolder = "claimant";
        det.hasShifted = true;
        det.shiftReason = "新产品制造方法举证责任倒置";
        det.reasoning =
          "权利人须先证明：1) 产品为新产品；2) 被诉产品与依专利方法制造的产品为同样产品。证明后举证责任转移至被诉侵权人";
        break;
      default:
        det.burdenHolder = "claimant";
        det.reasoning = "适用谁主张谁举证原则";
        break;
    }
    if (context?.burden_holder !== undefined) det.burdenHolder = context.burden_holder;
    return det;
  }

  /**
   * 证明标准达成评估（查找表驱动，删除了移植残留的死分支与双计数）：
   *   preponderance/优势证据：支持 > 矛盾 且 置信度 ≥ 0.5
   *   clear_and_convincing/高度盖然性：置信度 ≥ 0.7 且 支持 > 2×矛盾
   *   未知标准：置信度 ≥ 0.5（宽松放行）
   * 单条证据只计入一次（低分 → contradicting），无 conflict 双计数。
   */
  assessProofStandard(judgments: EvidenceJudgment[], standard: string): ProofStandardResult {
    const result: ProofStandardResult = {
      met: false,
      standard,
      confidence: 0,
      supportingCount: 0,
      contradictingCount: 0,
      reasoning: "",
      gaps: [],
    };
    let totalScore = 0;
    let validCount = 0;
    let supporting = 0;
    let contradicting = 0;
    for (const j of judgments) {
      validCount += 1;
      totalScore += j.overallScore;
      if (j.overallScore >= 0.6) {
        supporting += 1;
      } else {
        contradicting += 1;
      }
    }
    result.supportingCount = supporting;
    result.contradictingCount = contradicting;
    if (validCount > 0) result.confidence = totalScore / validCount;

    const STANDARDS: Record<string, { minConfidence: number; ratio: "preponderance" | "clear_convincing" }> = {
      [STANDARD_PREPONDERANCE]: { minConfidence: 0.5, ratio: "preponderance" },
      优势证据: { minConfidence: 0.5, ratio: "preponderance" },
      [STANDARD_CLEAR_CONVINCING]: { minConfidence: 0.7, ratio: "clear_convincing" },
      高度盖然性: { minConfidence: 0.7, ratio: "clear_convincing" },
    };
    const rule = STANDARDS[standard];
    if (rule !== undefined) {
      result.met =
        rule.ratio === "preponderance"
          ? supporting > contradicting && result.confidence >= rule.minConfidence
          : result.confidence >= rule.minConfidence && supporting > contradicting * 2;
    } else {
      result.met = result.confidence >= 0.5;
    }
    if (contradicting > 0) {
      result.gaps.push(`存在 ${contradicting} 件矛盾或低分证据，需进一步审查`);
    }
    if (validCount === 0) {
      result.gaps.push("无证据支持");
      result.met = false;
    }
    result.reasoning = `支持证据 ${supporting} 件 / 矛盾证据 ${contradicting} 件，平均置信度 ${(result.confidence * 100).toFixed(0)}%`;
    return result;
  }
}
