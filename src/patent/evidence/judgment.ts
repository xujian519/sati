/**
 * 三性判定（相关性/合法性/真实性）与等级映射。
 *
 * 从 engine.ts 拆出（#722）：本文件只做单维度评分与等级换算，不含编排、
 * 类型特定判定与规则表加载。
 */

import type { EvidenceSpan } from "./span.js";
import type { DimensionJudgment, EvidenceJudgment, EvidenceType } from "./types.js";

/** 三性默认权重（evidence-rules.yaml 缺失或字段非法时回退）。 */
export const DEFAULT_WEIGHTS = { relevance: 0.35, legality: 0.3, authenticity: 0.35 };

const LEVEL_HIGH = "high";
const LEVEL_MEDIUM_HIGH = "medium_high";
const LEVEL_MEDIUM = "medium";
const LEVEL_LOW = "low";

function levelFor(score: number, thresholds: Array<{ min: number; level: string }>, fallback: string): string {
  for (const t of thresholds) {
    if (score >= t.min) return t.level;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 三性判定（对齐 Mady evaluateRelevance / evaluateLegality / evaluateAuthenticity）
// ---------------------------------------------------------------------------

export function evaluateRelevance(span: EvidenceSpan): DimensionJudgment {
  let score = 0.5;
  if (span.sourceUri !== undefined && span.sourceUri !== "") score += 0.1;
  if ((span.claimRefs?.length ?? 0) > 0) score += 0.2;
  if (span.direction === "supporting" || span.direction === "contradicting") score += 0.1;
  if (span.snippet !== undefined && span.snippet !== "") score += 0.1;
  score = Math.min(score, 1.0);
  return {
    dimension: "relevance",
    score,
    level: levelFor(
      score,
      [
        { min: 0.85, level: LEVEL_HIGH },
        { min: 0.65, level: LEVEL_MEDIUM_HIGH },
        { min: 0.45, level: LEVEL_MEDIUM },
      ],
      LEVEL_LOW,
    ),
    reasoning: "相关性评估完成",
  };
}

export function evaluateAuthenticity(span: EvidenceSpan): DimensionJudgment {
  let score = 0.5;
  if (span.contentHash !== undefined && span.contentHash !== "") score += 0.3;
  if (span.docVersion !== undefined && span.docVersion !== "") score += 0.1;
  score = Math.min(score, 1.0);
  return {
    dimension: "authenticity",
    score,
    level: levelFor(
      score,
      [
        { min: 0.85, level: LEVEL_HIGH },
        { min: 0.65, level: LEVEL_MEDIUM_HIGH },
      ],
      LEVEL_LOW,
    ),
    reasoning: "真实性评估完成",
  };
}

export function evaluateLegality(span: EvidenceSpan): DimensionJudgment {
  let score = 0.7;
  if (span.sourceUri === undefined || span.sourceUri === "") score -= 0.2;
  if (span.contentHash !== undefined && span.contentHash !== "") score += 0.2;
  score = Math.max(0, Math.min(score, 1.0));
  return {
    dimension: "legality",
    score,
    level: levelFor(
      score,
      [
        { min: 0.85, level: LEVEL_HIGH },
        { min: 0.65, level: LEVEL_MEDIUM_HIGH },
      ],
      LEVEL_LOW,
    ),
    reasoning: "合法性评估完成",
  };
}

// ---------------------------------------------------------------------------
// 综合评分与判定叙述
// ---------------------------------------------------------------------------

/** 综合三性评分（权重可经 YAML 配置）；电子/互联网公开类按平台可信度修正。 */
export function computeOverallScore(
  judgment: EvidenceJudgment,
  weights: { relevance: number; legality: number; authenticity: number },
): number {
  const dims = [judgment.relevanceJudgment, judgment.legalityJudgment, judgment.authenticityJudgment];
  const weightList = [weights.relevance, weights.legality, weights.authenticity];
  let total = 0;
  let weightSum = 0;
  dims.forEach((d, i) => {
    if (d !== undefined) {
      total += d.score * weightList[i]!;
      weightSum += weightList[i]!;
    }
  });
  if (weightSum === 0) return 0.5;
  let base = total / weightSum;

  const ts = judgment.typeSpecificJudgment;
  if (ts?.credibilityScore !== undefined) {
    const modifier = 0.9 + 0.2 * ts.credibilityScore;
    base *= modifier;
  }
  // 0-1 评分契约：可信度修正可能使综合分超过 1.0（官方平台 0.95 → 修正 1.09），必须截断
  return Math.min(1, base);
}

export function buildReasoning(judgment: EvidenceJudgment, evType: EvidenceType): string {
  const parts: string[] = [];
  if (judgment.relevanceJudgment !== undefined) {
    parts.push(`关联性[${judgment.relevanceJudgment.level}]: ${judgment.relevanceJudgment.reasoning}`);
  }
  if (judgment.legalityJudgment !== undefined) {
    parts.push(`合法性[${judgment.legalityJudgment.level}]: ${judgment.legalityJudgment.reasoning}`);
  }
  if (judgment.authenticityJudgment !== undefined) {
    parts.push(`真实性[${judgment.authenticityJudgment.level}]: ${judgment.authenticityJudgment.reasoning}`);
  }
  const ts = judgment.typeSpecificJudgment;
  if (ts !== undefined) {
    switch (evType) {
      case "internet_publication": {
        const dd = ts.dateDetermination;
        const dateStr = dd !== undefined ? `${dd.determined}(${dd.reliability}/${dd.sourceType})` : "未知";
        parts.push(
          `类型检查[互联网公开]: 日期=${dateStr}, 可信度=${ts.platformCredibility ?? "未知"}(${(ts.credibilityScore ?? 0).toFixed(2)}), 完整性=${ts.contentIntegrity ?? "未知"}, 意图=${ts.publicIntent ?? "未知"}`,
        );
        break;
      }
      case "electronic":
        parts.push(
          `类型检查[电子证据]: 可信度=${ts.platformCredibility ?? "未知"}(${(ts.credibilityScore ?? 0).toFixed(2)})`,
        );
        break;
      case "public_use": {
        const fe = ts.fourElementsCheck;
        parts.push(
          `类型检查[使用公开]: 四要件=${fe === undefined ? "未评估" : fe.allMet ? "全部满足" : "未全部满足"}, 举证难度=${ts.burdenDifficulty ?? "未知"}, 证据链=${ts.chainIntegrity ?? "未知"}`,
        );
        break;
      }
      case "common_knowledge":
        parts.push(`类型检查[公知常识]: ${ts.exemptionApplied ?? "已完成"}`);
        break;
      default:
        parts.push(`类型检查[${evType}]: 已完成`);
        break;
    }
  }
  return parts.length === 0 ? "未执行评估" : parts.join("; ");
}
