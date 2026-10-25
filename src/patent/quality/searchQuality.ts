/**
 * src/patent/quality — 撰写流程确定性质量门纯函数（零依赖，可单测）。
 *
 * 对齐 prosecution-draft.yaml「检索结果质量检查」门槛：
 * 1. 对比文件 ≥ 3 篇
 * 2. 每篇标注了相关度（X/Y/A）与覆盖的权利要求
 * 3. 至少 2 篇获取了全文（PDF→Markdown 转换）
 * 4. 检索式包含布尔逻辑和 IPC 限定
 *
 * 纯字符串判定：不依赖 provider、不抛错；由 quality-gate 原子消费，
 * 不通过时挂 HITL 审批门由用户决策（退回重做 / 人工确认放行）。
 */

/** 最低对比文件数（多源检索）。 */
export const MIN_DOCS = 3;
/** 最低相关度标注（X/Y/A）处数。 */
export const MIN_RELATEDNESS_MARKS = 1;
/** 最低全文标注篇数（多源检索）。 */
export const MIN_FULLTEXT_MARKS = 2;
/** 单源检索的最低对比文件数：只有 nuo 一个库时 3 篇可能不可达，放宽到 2。 */
export const SINGLE_SOURCE_MIN_DOCS = 2;
/** 单源检索的最低全文标注篇数：同上，放宽到 1。 */
export const SINGLE_SOURCE_MIN_FULLTEXT_MARKS = 1;

export type SearchQualityThresholds = {
  minDocs: number;
  minRelatednessMarks: number;
  minFulltextMarks: number;
};

/** 多源检索（≥2 个源，或源数未知）的严格门槛。 */
export const MULTI_SOURCE_THRESHOLDS: SearchQualityThresholds = {
  minDocs: MIN_DOCS,
  minRelatednessMarks: MIN_RELATEDNESS_MARKS,
  minFulltextMarks: MIN_FULLTEXT_MARKS,
};

/** 单源检索的放宽门槛（仅对比文件数、全文覆盖放宽；相关度与检索式要求不变）。 */
export const SINGLE_SOURCE_THRESHOLDS: SearchQualityThresholds = {
  minDocs: SINGLE_SOURCE_MIN_DOCS,
  minRelatednessMarks: MIN_RELATEDNESS_MARKS,
  minFulltextMarks: SINGLE_SOURCE_MIN_FULLTEXT_MARKS,
};

export type SearchQualityOptions = {
  /**
   * 装配时启用的检索源数量（如 nuo 专利 + paper 论文 = 2），**不是**本次运行成功源数。
   * 只有恰好 1 个源才放宽：源数未知、0 或多源都按严格门槛——
   * 运行期某个源失败不应触发放宽（保守，避免失败越多门槛越低）。
   */
  sourceCount?: number;
};

/** 按源数选门槛：恰好 1 源放宽；未知/0/多源严格。 */
export function resolveSearchQualityThresholds(sourceCount?: number): {
  thresholds: SearchQualityThresholds;
  adjusted: boolean;
} {
  return sourceCount === 1
    ? { thresholds: SINGLE_SOURCE_THRESHOLDS, adjusted: true }
    : { thresholds: MULTI_SOURCE_THRESHOLDS, adjusted: false };
}

/** 专利号/公开号识别（CN1234567A、US20240012345A1 等）。 */
const PATENT_NO_RE = /\b(?:CN|US|EP|WO|JP|KR|GB|DE|FR|CA|AU)\s?[A-Z]?\d[\dA-Z]{3,}\b/g;
/** 相关度标注："相关度: X" / "类别 Y" / "X类" 等。 */
const RELATEDNESS_RE = /(?:相关度|类别|类)\s*[:：]?\s*[XYA]/g;
/** 全文获取标注。 */
const FULLTEXT_RE = /全文/g;
/** 布尔检索式（AND/OR/NOT）。 */
const BOOLEAN_RE = /\b(?:AND|OR|NOT)\b/;
/** IPC 限定：显式 "IPC/分类号/Int.Cl" 字样或 IPC 分类号段（如 G06F3、A61K31）。 */
const IPC_RE = /(?:IPC|分类号|Int\.?\s?Cl)|(?:^|[^\dA-Z])(?:[ABCFGH]\d{2}[A-Z]\d{1,4})/;

export type SearchQualityResult = {
  /** 是否全部门槛通过。 */
  passed: boolean;
  /** 未通过项（人类可读，供 HITL 决策）。 */
  failures: string[];
  /** 调用方传入的装配时检索源数量（未传则缺省）。 */
  sourceCount?: number;
  /** 是否因单源检索放宽了门槛。 */
  thresholdsAdjusted: boolean;
  /** 本次判定实际使用的门槛（审计用）。 */
  thresholds: SearchQualityThresholds;
  details: {
    docCount: number;
    relatednessMarks: number;
    fullTextMarks: number;
    hasBooleanQuery: boolean;
    hasIpcLimit: boolean;
  };
};

/** 检索质量确定性门槛（纯函数）。 */
export function checkSearchQuality(text: string, options?: SearchQualityOptions): SearchQualityResult {
  const { sourceCount } = options ?? {};
  const { thresholds, adjusted } = resolveSearchQualityThresholds(sourceCount);
  const patentMatches = text.match(PATENT_NO_RE) ?? [];
  // 对比文件条目（"对比文件 1：…" / "【对比文件1】" 形式，来自 quality-gate 原子序列化的 prior_art）。
  const entryMatches = text.match(/对比文件\s*[0-9０-９]+/g) ?? [];
  const docCount = Math.max(patentMatches.length, entryMatches.length);
  const relatednessMarks = (text.match(RELATEDNESS_RE) ?? []).length;
  const fullTextMarks = (text.match(FULLTEXT_RE) ?? []).length;
  const hasBooleanQuery = BOOLEAN_RE.test(text);
  const hasIpcLimit = IPC_RE.test(text);

  const failures: string[] = [];
  if (docCount < thresholds.minDocs) {
    failures.push(`对比文件不足 ${thresholds.minDocs} 篇（识别到 ${docCount} 篇）`);
  }
  if (relatednessMarks < thresholds.minRelatednessMarks) {
    failures.push(`相关度标注（X/Y/A）不足 ${thresholds.minRelatednessMarks} 处（识别到 ${relatednessMarks} 处）`);
  }
  if (fullTextMarks < thresholds.minFulltextMarks) {
    failures.push(`全文获取标注不足 ${thresholds.minFulltextMarks} 篇（识别到 ${fullTextMarks} 处"全文"）`);
  }
  if (!hasBooleanQuery) {
    failures.push("检索式未包含布尔逻辑（AND/OR/NOT）");
  }
  if (!hasIpcLimit) {
    failures.push("检索式未包含 IPC 限定");
  }

  return {
    passed: failures.length === 0,
    failures,
    ...(sourceCount !== undefined ? { sourceCount } : {}),
    thresholdsAdjusted: adjusted,
    thresholds,
    details: { docCount, relatednessMarks, fullTextMarks, hasBooleanQuery, hasIpcLimit },
  };
}
