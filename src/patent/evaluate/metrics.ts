/**
 * src/patent/evaluate — 确定性评估指标（对齐 Mady evaluate/metrics.go）。
 *
 * - keywordRecall：参考答案关键词在产出中的召回率；
 * - citationCompleteness：必备法条引文在产出中的完整率；
 * - ruleGatePass：规则门判级（1 = pass，0 = 其他）。
 */

/** 从参考答案提取关键词（中文按 4 字符以上短语切分，过滤标点与常见虚词）。 */
export function extractKeywords(expected: string, max = 12): string[] {
  const tokens = expected.match(/[\u4e00-\u9fff]{4,}/g) ?? [];
  const stop = new Set(["本领域技术人员", "权利要求书", "说明书应当", "其特征在于"]);
  const unique = [...new Set(tokens)];
  return unique.filter(t => !stop.has(t)).slice(0, max);
}

/** 关键词召回率：参考答案关键词在产出中出现的比例（0-1）。 */
export function keywordRecall(expected: string, actual: string): number {
  const keywords = extractKeywords(expected);
  if (keywords.length === 0) return 1; // 无可比关键词视为通过（宽松）。
  const lower = actual.toLowerCase();
  const hit = keywords.filter(k => {
    // 长短语（>4 字）用核心 4 字前缀匹配，容忍中间措辞差异。
    const core = k.length > 4 ? k.slice(0, 4) : k;
    return lower.includes(k.toLowerCase()) || lower.includes(core.toLowerCase());
  }).length;
  return hit / keywords.length;
}

/** 法条引文完整率：必备引文在产出中出现的比例（未要求引文时为 1）。 */
export function citationCompleteness(actual: string, requiredCitations: readonly string[] = []): number {
  if (requiredCitations.length === 0) return 1;
  const lower = actual.toLowerCase();
  const hit = requiredCitations.filter(c => lower.includes(c.toLowerCase())).length;
  return hit / requiredCitations.length;
}

/** 规则门判级分数：pass = 1，否则 0。 */
export function ruleGatePass(verdict: string): number {
  return verdict === "pass" ? 1 : 0;
}

/** 相似度（Jaccard：参考答案与产出共有关键词 / 并集）。 */
export function jaccardSimilarity(expected: string, actual: string): number {
  const a = new Set(extractKeywords(expected, 30));
  const b = new Set(extractKeywords(actual, 30));
  if (a.size === 0 && b.size === 0) return 1;
  const union = new Set([...a, ...b]);
  const inter = [...a].filter(k => b.has(k)).length;
  return inter / union.size;
}
