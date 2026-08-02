/**
 * 证据判断引擎（移植自 Mady domains/evidence/engine.go + triple_attrs.go）。
 *
 * 对单条证据做三性判定（相关性/合法性/真实性）+ 类型特定判定（电子证据/
 * 互联网公开/域外/证人/公知常识/使用公开/现有技术日期），综合评分；
 * 并提供举证责任分配与证明标准达成评估。
 *
 * 设计对齐 Mady：确定性判定（无 LLM），权重可经 YAML 资产
 * （rules/patent/evidence-rules.yaml）配置；外部服务不可用时降级而非失败。
 */

import { parseDocument } from "yaml";
import type { EvidenceSpan } from "./span.js";
import {
  determinePublicationDate,
  extractDateFromText,
  inferredMonthEnd,
  isBeforeFilingDate,
  isMonthOnlyDate,
  isPreciseDate,
  parseDateFlexible,
} from "./date.js";
import { credibilityToScore, evaluatePublicIntent, platformCategory, platformCredibility } from "./credibility.js";
import type {
  AssessmentDimension,
  AssessmentType,
  BurdenDetermination,
  ContentIntegrityStatus,
  CredibilityLevel,
  DateDetermination,
  DimensionJudgment,
  ElementResult,
  EvidenceExternalInputs,
  EvidenceJudgment,
  EvidenceJudgmentEngine,
  EvidenceRule,
  EvidenceRuleSet,
  EvidenceType,
  FourElementsResult,
  JudgmentIssue,
  ProofStandardResult,
  RuleApplication,
  TypeSpecificJudgment,
} from "./types.js";
import { EVIDENCE_TYPES } from "./types.js";

/** 规则条件评估上下文。 */
type ConditionContext = {
  span: EvidenceSpan;
  filingDate?: string;
  external: EvidenceExternalInputs;
};

/**
 * 规则条件评估器：已知条件（span/日期可判）返回 true/false；
 * 外部输入条件（公证/译本/证人披露等）未提供时返回 undefined（pending）；
 * 未知条件返回 undefined（不误判）。
 */
function evaluateCondition(name: string, ctx: ConditionContext): boolean | undefined {
  switch (name) {
    case "evidence_has_claim_refs":
      return (ctx.span.claimRefs?.length ?? 0) > 0;
    case "evidence_direction_clear":
      return ctx.span.direction === "supporting" || ctx.span.direction === "contradicting";
    case "evidence_source_identified":
      return Boolean(ctx.span.sourceUri);
    case "evidence_content_hash_available":
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
    default:
      return undefined;
  }
}

/** 证明标准标识。 */
export const STANDARD_PREPONDERANCE = "preponderance";
export const STANDARD_CLEAR_CONVINCING = "clear_and_convincing";

const DEFAULT_WEIGHTS = { relevance: 0.35, legality: 0.3, authenticity: 0.35 };

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

function evaluateRelevance(span: EvidenceSpan): DimensionJudgment {
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

function evaluateAuthenticity(span: EvidenceSpan): DimensionJudgment {
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

function evaluateLegality(span: EvidenceSpan): DimensionJudgment {
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
// 类型特定判定（对齐 Mady evaluateTypeSpecific + 使用公开辅助函数）
// ---------------------------------------------------------------------------

/** 从证据特征推断证据类型；显式类型优先，否则按 URI scheme/内容启发式。 */
export function inferEvidenceType(span: EvidenceSpan): EvidenceType {
  const uri = span.sourceUri ?? "";
  if (uri.startsWith("web_pub:") || uri.startsWith("http_archive:")) return "internet_publication";
  // web: 是工具文档约定的默认格式（"web:https://…判定平台可信度"）：网络来源
  // 走互联网公开类型特定检查（公开日/平台可信度/完整性/公开意图），
  // 而不是落回 general 仅做三性启发式评分。
  if (uri.startsWith("web:")) return "internet_publication";
  if (uri.startsWith("pub_use:") || uri.startsWith("public_use:")) return "public_use";
  if (uri.startsWith("witness:")) return "witness_testimony";
  if (uri.startsWith("patent:") || uri.startsWith("prior_art:")) return "prior_art_date";
  if (uri.startsWith("notary:") || uri.includes("notariz")) return "notarial_certificate";
  return "general";
}

/** 内容完整性状态（对齐 Mady evaluateInternetContentIntegrity：哈希可验证即 verified）。 */
function evaluateContentIntegrity(span: EvidenceSpan): ContentIntegrityStatus {
  if (span.contentHash !== undefined && span.contentHash !== "") return "verified";
  return "unverified";
}

/** 互联网公开日期推定（页面标注日期 > Wayback Machine）。 */
function determineInternetPublicationDate(span: EvidenceSpan, filingDate?: string): DateDetermination {
  return determinePublicationDate(span.docVersion, span.sourceUri, filingDate);
}

function evaluateTypeSpecific(span: EvidenceSpan, evType: EvidenceType, filingDate?: string): TypeSpecificJudgment {
  const ts: TypeSpecificJudgment = { evidenceType: evType };
  const uri = span.sourceUri ?? "";

  switch (evType) {
    case "electronic": {
      const level = platformCredibility(uri);
      ts.platformCredibility = level;
      ts.credibilityScore = credibilityToScore(level);
      break;
    }
    case "foreign_language":
      ts.translationStatus = "unknown";
      break;
    case "overseas":
      if (span.contentHash !== undefined && span.contentHash !== "") ts.platformCredibility = "high";
      break;
    case "notarial_certificate":
      ts.notarizationStatus = "confirmed";
      break;
    case "witness_testimony":
      ts.witnessCredibility = "medium";
      break;
    case "common_knowledge":
      ts.exemptionApplied = "无需举证";
      break;
    case "prior_art_date":
      ts.dateDetermination = determineInternetPublicationDate(span, filingDate);
      break;
    case "internet_publication": {
      ts.dateDetermination = determineInternetPublicationDate(span, filingDate);
      const level = platformCredibility(uri);
      ts.platformCredibility = level;
      ts.credibilityScore = credibilityToScore(level);
      ts.platformCategory = platformCategory(uri);
      ts.contentIntegrity = evaluateContentIntegrity(span);
      ts.publicIntent = evaluatePublicIntent(uri);
      break;
    }
    case "public_use": {
      ts.dateDetermination = determinePublicUseDate(span, filingDate);
      ts.fourElementsCheck = evaluateFourElements(span);
      ts.burdenDifficulty = assessBurdenDifficulty(ts.fourElementsCheck);
      ts.chainIntegrity = assessChainIntegrity(span, ts.fourElementsCheck);
      break;
    }
    default:
      break;
  }
  return ts;
}

/** 使用公开日期推定（主张日期 > 描述文本提取）。 */
function determinePublicUseDate(span: EvidenceSpan, filingDate?: string): DateDetermination {
  const result: DateDetermination = {
    sourceDate: span.docVersion ?? "",
    determined: "unknown",
    method: "public_use",
    isPriorArt: false,
    filingDate,
    reliability: "low",
    sourceType: "claimed_date",
  };
  if (span.docVersion !== undefined && span.docVersion !== "") {
    const parsed = parseDateFlexible(span.docVersion);
    if (parsed !== null) {
      if (isPreciseDate(span.docVersion)) {
        // 精确日期（含英文月份格式 "Jan 15, 2023"）：直接采用，不得截为年-月
        result.determined = span.docVersion;
        result.reliability = "medium";
      } else if (isMonthOnlyDate(span.docVersion)) {
        result.determined = inferredMonthEnd(parsed);
        result.reliability = "low";
      } else {
        // 可解析但精度不足的日期：保留解析值（不再落 "unknown"）
        result.determined = span.docVersion;
        result.reliability = "low";
      }
      result.isPriorArt = isBeforeFilingDate(result.determined, filingDate);
      return result;
    }
  }
  const extracted = extractDateFromText(span.snippet ?? "");
  if (extracted !== "") {
    result.sourceDate = extracted;
    result.determined = extracted;
    result.reliability = "low";
    result.sourceType = "inferred";
    result.isPriorArt = isBeforeFilingDate(extracted, filingDate);
  }
  return result;
}

function containsAny(snippet: string, keywords: readonly string[]): boolean {
  const lower = snippet.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

/** 使用公开四要件检查（时间/地点/方式/公众可获取性，对齐 Mady evaluateFourElements）。 */
export function evaluateFourElements(span: EvidenceSpan): FourElementsResult {
  const timeElement = evaluatePublicUseTime(span);
  const placeElement = evaluatePublicUsePlace(span);
  const methodElement = evaluatePublicUseMethod(span);
  const accessibility = evaluatePublicUseAccessibility(span);
  const allMet = timeElement.met && placeElement.met && methodElement.met && accessibility.met;
  return {
    timeElement,
    placeElement,
    methodElement,
    accessibility,
    allMet,
    overallScore: (timeElement.score + placeElement.score + methodElement.score + accessibility.score) / 4,
  };
}

function evaluatePublicUseTime(span: EvidenceSpan): ElementResult {
  if (span.docVersion === undefined || span.docVersion === "") {
    return { met: false, score: 0.25, detail: "未提供使用公开日期，无法判断是否在申请日之前" };
  }
  if (parseDateFlexible(span.docVersion) === null) {
    return { met: false, score: 0.3, detail: `日期格式无法识别: ${span.docVersion}` };
  }
  if (isPreciseDate(span.docVersion)) {
    return { met: true, score: 0.9, detail: `使用公开日期为 ${span.docVersion}，格式完整` };
  }
  return { met: true, score: 0.7, detail: `使用公开日期为 ${span.docVersion}，精度不足，需补充具体日期` };
}

function evaluatePublicUsePlace(span: EvidenceSpan): ElementResult {
  const snippet = (span.snippet ?? "").toLowerCase();
  const domesticIndicators = ["中国", "北京", "上海", "广州", "深圳", "国内", "境内"];
  const foreignIndicators = ["美国", "us", "europe", "日本", "国外", "境外", "international"];
  if (containsAny(snippet, domesticIndicators)) {
    return { met: true, score: 0.85, detail: "使用行为发生在中国境内（构成国内公开）" };
  }
  if (containsAny(snippet, foreignIndicators)) {
    return { met: true, score: 0.8, detail: "使用行为发生在境外（构成国外公开，中国专利法采用绝对新颖性标准）" };
  }
  return { met: true, score: 0.6, detail: "未明确提及使用地点，推定使用行为已公开（需进一步核实具体地点）" };
}

function evaluatePublicUseMethod(span: EvidenceSpan): ElementResult {
  const snippet = (span.snippet ?? "").toLowerCase();
  const salesIndicators = ["销售", "出售", "售卖", "购买", "sell", "sale", "transaction"];
  const exhibitionIndicators = ["展览", "展出", "展示", "演示", "exhibition", "expo", "fair", "show", "demonstrat"];
  const publicationIndicators = ["出版", "发布", "发表", "公开", "publish", "release", "post"];
  const otherIndicators = ["使用", "实施", "制造", "生产", "use", "manufactur", "produc"];

  if (containsAny(snippet, salesIndicators)) {
    return { met: true, score: 0.9, detail: "通过销售行为公开使用" };
  }
  if (containsAny(snippet, exhibitionIndicators)) {
    return { met: true, score: 0.85, detail: "通过展览或展示行为公开使用" };
  }
  if (containsAny(snippet, publicationIndicators)) {
    return { met: true, score: 0.75, detail: "通过发布/发表行为公开使用" };
  }
  if (containsAny(snippet, otherIndicators)) {
    return { met: true, score: 0.6, detail: "通过其他方式公开使用，需进一步明确具体方式" };
  }
  return { met: false, score: 0.3, detail: "未识别出明确的使用公开方式，需补充公开方式的描述（如销售、展览、演示等）" };
}

function evaluatePublicUseAccessibility(span: EvidenceSpan): ElementResult {
  const snippet = (span.snippet ?? "").toLowerCase();
  const confidentialityIndicators = ["保密", "秘密", "confidential", "保密协议", "nda", "non-disclosure"];
  const limitedAccessIndicators = ["内部", "内测", "内部测试", "closed", "internal", "invite-only"];
  const publicAccessIndicators = ["公开", "开放", "公众", "public", "open", "anyone"];

  if (containsAny(snippet, confidentialityIndicators)) {
    return { met: false, score: 0.2, detail: "存在保密义务或保密措施，可能不构成公众可获取" };
  }
  if (containsAny(snippet, limitedAccessIndicators)) {
    return { met: false, score: 0.35, detail: "使用行为限于特定范围，非对公众开放" };
  }
  if (containsAny(snippet, publicAccessIndicators)) {
    return { met: true, score: 0.9, detail: "使用行为对公众开放，公众可获取" };
  }
  return { met: true, score: 0.65, detail: "未提及保密措施，推定为公众可获取" };
}

function assessBurdenDifficulty(fourElements: FourElementsResult | undefined): string {
  if (fourElements === undefined) return "无法评估";
  const metCount = [
    fourElements.timeElement,
    fourElements.placeElement,
    fourElements.methodElement,
    fourElements.accessibility,
  ].filter(e => e.met).length;
  if (metCount >= 4) return "中";
  if (metCount >= 2) return "高";
  return "极高";
}

function assessChainIntegrity(span: EvidenceSpan, fourElements: FourElementsResult | undefined): string {
  if (fourElements === undefined) return "无法评估";
  if (fourElements.allMet) {
    if (span.contentHash !== undefined && span.contentHash !== "") {
      return "完整（四要素齐全且内容可哈希验证）";
    }
    return "较完整（四要素齐全，建议补充旁证印证）";
  }
  if (span.snippet !== undefined && span.snippet !== "") {
    return "需补充证据（部分要件缺失，建议提供销售合同/展览记录等直接证据）";
  }
  return "证据链不完整，建议收集多份相互印证的证据";
}

// ---------------------------------------------------------------------------
// 规则索引（YAML 资产加载）
// ---------------------------------------------------------------------------

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
function parseRuleSet(yamlText: string, source: string): { ruleSet: EvidenceRuleSet | null; warnings: string[] } {
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
    judgment.overallScore = this.computeOverallScore(judgment);
    // confidence 与评分关联（低分证据不应宣称"确信"）——固定 1.0 是误导。
    judgment.confidence = Number(judgment.overallScore.toFixed(3));
    judgment.rulesApplied = this.applyRules(span, evType, filingDate, external);
    judgment.reasoning = this.buildReasoning(judgment, evType);
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

  /** 综合三性评分（权重可经 YAML 配置）；电子/互联网公开类按平台可信度修正。 */
  private computeOverallScore(judgment: EvidenceJudgment): number {
    const dims: Array<DimensionJudgment | undefined> = [
      judgment.relevanceJudgment,
      judgment.legalityJudgment,
      judgment.authenticityJudgment,
    ];
    const weights = [this.weights.relevance, this.weights.legality, this.weights.authenticity];
    let total = 0;
    let weightSum = 0;
    dims.forEach((d, i) => {
      if (d !== undefined) {
        total += d.score * weights[i]!;
        weightSum += weights[i]!;
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

  private buildReasoning(judgment: EvidenceJudgment, evType: EvidenceType): string {
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
}

export type { CredibilityLevel };
