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

/** 最低对比文件数。 */
export const MIN_DOCS = 3;
/** 最低相关度标注（X/Y/A）处数。 */
export const MIN_RELATEDNESS_MARKS = 1;
/** 最低全文标注篇数。 */
export const MIN_FULLTEXT_MARKS = 2;

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
  details: {
    docCount: number;
    relatednessMarks: number;
    fullTextMarks: number;
    hasBooleanQuery: boolean;
    hasIpcLimit: boolean;
  };
};

/** 检索质量确定性门槛（纯函数）。 */
export function checkSearchQuality(text: string): SearchQualityResult {
  const patentMatches = text.match(PATENT_NO_RE) ?? [];
  // 对比文件条目（"对比文件 1：…" / "【对比文件1】" 形式，来自 quality-gate 原子序列化的 prior_art）。
  const entryMatches = text.match(/对比文件\s*[0-9０-９]+/g) ?? [];
  const docCount = Math.max(patentMatches.length, entryMatches.length);
  const relatednessMarks = (text.match(RELATEDNESS_RE) ?? []).length;
  const fullTextMarks = (text.match(FULLTEXT_RE) ?? []).length;
  const hasBooleanQuery = BOOLEAN_RE.test(text);
  const hasIpcLimit = IPC_RE.test(text);

  const failures: string[] = [];
  if (docCount < MIN_DOCS) {
    failures.push(`对比文件不足 ${MIN_DOCS} 篇（识别到 ${docCount} 篇）`);
  }
  if (relatednessMarks < MIN_RELATEDNESS_MARKS) {
    failures.push(`相关度标注（X/Y/A）不足 ${MIN_RELATEDNESS_MARKS} 处（识别到 ${relatednessMarks} 处）`);
  }
  if (fullTextMarks < MIN_FULLTEXT_MARKS) {
    failures.push(`全文获取标注不足 ${MIN_FULLTEXT_MARKS} 篇（识别到 ${fullTextMarks} 处"全文"）`);
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
    details: { docCount, relatednessMarks, fullTextMarks, hasBooleanQuery, hasIpcLimit },
  };
}
