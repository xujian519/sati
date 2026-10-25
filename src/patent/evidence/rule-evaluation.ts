/**
 * 证据规则表评估：YAML 资产解析 + 单条规则条件求值。
 *
 * 从 engine.ts 拆出（#722）：本文件只处理"规则怎么读、条件怎么判"，
 * 不持有引擎状态（权重/规则表由 EvidenceEngine 装载）。
 */

import { parseDocument } from "yaml";
import { DEFAULT_WEIGHTS } from "./judgment.js";
import type { EvidenceSpan } from "./span.js";
import type {
  AssessmentDimension,
  AssessmentType,
  EvidenceExternalInputs,
  EvidenceRule,
  EvidenceRuleSet,
  EvidenceType,
} from "./types.js";
import { EVIDENCE_TYPES } from "./types.js";

/** 规则条件评估上下文。 */
export type ConditionContext = {
  span: EvidenceSpan;
  filingDate?: string;
  external: EvidenceExternalInputs;
};

/**
 * 规则条件评估器：已知条件（span/日期可判）返回 true/false；
 * 外部输入条件（公证/译本/证人披露等）未提供时返回 undefined（pending）；
 * 未知条件返回 undefined（不误判）。
 */
export function evaluateCondition(name: string, ctx: ConditionContext): boolean | undefined {
  switch (name) {
    case "evidence_has_claim_refs":
      return (ctx.span.claimRefs?.length ?? 0) > 0;
    case "evidence_direction_clear":
      return ctx.span.direction === "supporting" || ctx.span.direction === "contradicting";
    case "evidence_source_identified":
      return Boolean(ctx.span.sourceUri);
    case "evidence_content_hash_available":
    case "content_hash_provided":
      return Boolean(ctx.span.contentHash);
    case "evidence_provenance_clear":
      return Boolean(ctx.span.sourceUri) || Boolean(ctx.span.docVersion);
    case "evidence_has_source_uri":
      return Boolean(ctx.span.sourceUri);
    case "publication_date_available":
      return Boolean(ctx.span.docVersion);
    case "filing_date_available":
      return Boolean(ctx.filingDate);
    case "evidence_notarized":
      return ctx.external.notarized;
    case "evidence_legalized":
      return ctx.external.legalized;
    case "evidence_translated":
      return ctx.external.translated;
    case "evidence_witness_disclosed":
      return ctx.external.witnessDisclosed;
    case "fact_is_well_known":
      return ctx.external.isWellKnown;
    case "fact_is_uncontested":
      return ctx.external.isUncontested;
    case "deadline_defined":
      return ctx.external.deadlineDefined;
    case "submission_within_deadline":
      return ctx.external.submissionWithinDeadline;
    // ── EVI-002 证据收集合法性（外部输入；未提供时 pending）──
    case "evidence_collection_legal":
      return ctx.external.collectionLegal;
    // ── EVI-020 举证责任：案件类型已识别（外部输入；未提供时 pending）──
    case "case_type_identified":
      return typeof ctx.external.caseType === "string" && ctx.external.caseType.trim().length > 0 ? true : undefined;
    // ── EVI-030 证明标准：支持/矛盾证据已计数（外部输入；未提供时 pending）──
    case "supporting_evidence_counted":
      return typeof ctx.external.supportingCount === "number" ? true : undefined;
    case "contradicting_evidence_counted":
      return typeof ctx.external.contradictingCount === "number" ? true : undefined;
    // ── EVI-050 证据链：保管链可追溯 / 完整性已核验（外部输入；未提供时 pending）──
    case "custody_chain_traceable":
      return ctx.external.custodyChainTraceable;
    case "evidence_integrity_verified":
      return ctx.external.integrityVerified;
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** 解析规则集的评估维度与权重；单个坏规则跳过不阻塞整体加载。 */
export function parseRuleSet(
  yamlText: string,
  source: string,
): { ruleSet: EvidenceRuleSet | null; warnings: string[] } {
  const warnings: string[] = [];
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    warnings.push(`证据规则 YAML 解析失败 ${source}: ${doc.errors[0]?.message ?? "unknown"}`);
    return { ruleSet: null, warnings };
  }
  const root = asRecord(doc.toJS());
  if (root === null) {
    warnings.push(`证据规则文件顶层必须是对象 ${source}`);
    return { ruleSet: null, warnings };
  }
  const weightsRaw = asRecord(root.weights);
  const weights = {
    relevance: typeof weightsRaw?.relevance === "number" ? weightsRaw.relevance : DEFAULT_WEIGHTS.relevance,
    legality: typeof weightsRaw?.legality === "number" ? weightsRaw.legality : DEFAULT_WEIGHTS.legality,
    authenticity: typeof weightsRaw?.authenticity === "number" ? weightsRaw.authenticity : DEFAULT_WEIGHTS.authenticity,
  };
  const rules: EvidenceRule[] = [];
  const rawRules = root.rules;
  if (Array.isArray(rawRules)) {
    for (const item of rawRules) {
      const record = asRecord(item);
      if (record === null || typeof record.ruleId !== "string" || typeof record.name !== "string") {
        warnings.push(`证据规则条目缺少 ruleId/name ${source}`);
        continue;
      }
      const evidenceType = record.evidenceType as EvidenceType;
      if (!EVIDENCE_TYPES.includes(evidenceType)) {
        warnings.push(`证据规则 ${record.ruleId} 未知证据类型 "${record.evidenceType}"，跳过`);
        continue;
      }
      const assessment = asRecord(record.evidenceAssessment);
      let dimensions: AssessmentDimension[] | undefined;
      if (assessment !== null && Array.isArray(assessment.dimensions)) {
        dimensions = [];
        for (const dimRaw of assessment.dimensions) {
          const dim = asRecord(dimRaw);
          if (dim === null || typeof dim.name !== "string" || typeof dim.weight !== "number") continue;
          const levels = Array.isArray(dim.levels)
            ? dim.levels
                .map(lv => asRecord(lv))
                .filter((lv): lv is Record<string, unknown> => lv !== null)
                .map(lv => ({
                  value: typeof lv.value === "string" ? lv.value : "",
                  score: typeof lv.score === "number" ? lv.score : 0,
                  description: typeof lv.description === "string" ? lv.description : undefined,
                }))
                .filter(lv => lv.value !== "")
            : [];
          dimensions.push({ name: dim.name, weight: dim.weight, levels });
        }
      }
      const check = asRecord(record.check);
      rules.push({
        ruleId: record.ruleId,
        name: record.name,
        description: typeof record.description === "string" ? record.description : "",
        legalBasis: typeof record.legalBasis === "string" ? record.legalBasis : undefined,
        domain: typeof record.domain === "string" ? record.domain : undefined,
        severity: typeof record.severity === "string" ? record.severity : "minor",
        action: typeof record.action === "string" ? record.action : "apply",
        evidenceType,
        check: check
          ? {
              type: typeof check.type === "string" ? check.type : "",
              method: typeof check.method === "string" ? check.method : "",
              principles: asStringArray(check.principles),
              rules: asStringArray(check.rules),
              conditions: asStringArray(check.conditions),
            }
          : undefined,
        evidenceAssessment: assessment
          ? {
              assessmentType: (typeof assessment.assessmentType === "string"
                ? assessment.assessmentType
                : "triple-attribute") as AssessmentType,
              dimensions,
              exemptions: asStringArray(assessment.exemptions),
            }
          : undefined,
      });
    }
  } else {
    warnings.push(`证据规则文件缺少 rules 数组 ${source}`);
  }
  return { ruleSet: { weights, rules }, warnings };
}
