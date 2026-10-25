/**
 * 证据类型推断与类型特定判定（电子证据/互联网公开/域外/证人/公知常识/
 * 使用公开/现有技术日期）。
 *
 * 从 engine.ts 拆出（#722）：本文件只回答"这是什么类型的证据、该类型该查
 * 什么"，综合评分与规则表编排仍在 engine.ts。
 */

import { credibilityToScore, evaluatePublicIntent, platformCategory, platformCredibility } from "./credibility.js";
import { determinePublicationDate, extractDateFromText, inferredMonthEnd, isBeforeFilingDate } from "./date.js";
import { isMonthOnlyDate, isPreciseDate, parseDateFlexible } from "./date.js";
import { assessBurdenDifficulty, assessChainIntegrity, evaluateFourElements } from "./four-elements.js";
import type { EvidenceSpan } from "./span.js";
import type { ContentIntegrityStatus, DateDetermination, EvidenceType, TypeSpecificJudgment } from "./types.js";

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

export function evaluateTypeSpecific(
  span: EvidenceSpan,
  evType: EvidenceType,
  filingDate?: string,
): TypeSpecificJudgment {
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
