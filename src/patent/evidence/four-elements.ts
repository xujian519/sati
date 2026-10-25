/**
 * 使用公开四要件（时间/地点/方式/公众可获取性）判定。
 *
 * 从 engine.ts 拆出（#722）：只做四要件机器打分与由其派生的举证难度/
 * 证据链完整性评估；日期推定在 type-inference.ts，规则表在 rule-evaluation.ts。
 */

import { isPreciseDate, parseDateFlexible } from "./date.js";
import type { EvidenceSpan } from "./span.js";
import type { ElementResult, FourElementsResult } from "./types.js";

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

export function assessBurdenDifficulty(fourElements: FourElementsResult | undefined): string {
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

export function assessChainIntegrity(span: EvidenceSpan, fourElements: FourElementsResult | undefined): string {
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
