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

// ---------------------------------------------------------------------------
// conclusionDirection —— 结论方向指标（a22.3 创造性专属基准）
// ---------------------------------------------------------------------------

/**
 * 结论方向标记（M0-1 fixture 固定单行）：`结论：具备创造性` / `结论：不具备创造性`。
 * 仅匹配带"结论："前缀的表述（正文其他含"创造"的句子不参与方向判定）。
 */
const DIRECTION_RE = /结论[:：]\s*(不?)\s*具备创造性/g;

/** 提取文本中的结论方向（矛盾输出返回 undefined）。 */
export function extractDirection(text: string): "inventive" | "not_inventive" | undefined {
  const matches = [...text.matchAll(DIRECTION_RE)];
  if (matches.length === 0) return undefined;
  const negative = matches.filter(m => m[1] === "不").length;
  const positive = matches.length - negative;
  if (negative > 0 && positive === 0) return "not_inventive";
  if (positive > 0 && negative === 0) return "inventive";
  return undefined; // 同时出现正反标记（矛盾）→ 无法判定
}

/**
 * 结论方向指标：actual 结论方向与 expected 标记一致 → 1，否则 0。
 * expected 只认 M0-1 固定单行标记（`结论：具备创造性` / `结论：不具备创造性`）；
 * actual 侧只扫描创造性结论区块（`## inventiveness_conclusion`，找不到时回退整段），
 * 用紧邻否定检测区分"不具备创造性"/"缺乏创造性"/"无法确立创造性"等否定表述与
 * 肯定表述（疑问句"是否具备创造性"不参与）。expected 无唯一标记或无法解析 → 1
 * （不影响旧 suite：a26.3/a22 等 expected 均无该标记）。
 */
export function conclusionDirection(expected: string, actual: string): number {
  const expectedDirection = extractDirection(expected);
  if (expectedDirection === undefined) return 1;
  const actualDirection = extractActualDirection(conclusionSection(actual));
  if (actualDirection === undefined) return 0;
  return actualDirection === expectedDirection ? 1 : 0;
}

/** 提取创造性结论区块（图模式结论键；找不到时回退整段，兼容单文本模式）。 */
function conclusionSection(output: string): string {
  const marker = "## inventiveness_conclusion";
  const idx = output.indexOf(marker);
  if (idx === -1) return output;
  const next = output.indexOf("\n## ", idx + marker.length);
  return next === -1 ? output.slice(idx) : output.slice(idx, next);
}

/** 否定表述模式："不/未/无/非/缺乏/没有/无法/难以 + 情态词 + （具备/具有/存在）? + 创造性"。 */
const NEGATED_PHRASE_RE =
  /(?:不|未|无|非|缺乏|没有|无法|难以)(?:能|会|认为|视为|确立|认定|构成|满足|通过)?\s*.{0,6}?\s*创造性/g;
/** 肯定表述模式："具备/具有/存在 + 创造性"（排除"是否具备创造性"等疑问句）。 */
const POSITIVE_PHRASE_RE = /(?<!是否)(?:具备|具有|存在)\s*创造性/g;

/**
 * 提取 actual 中的结论方向：统计"创造性"出现的否定/肯定占比
 * （"不具备创造性"/"缺乏创造性"/"无法确立创造性"为否定；"具备/具有创造性"为肯定）。
 * 全部否定 → not_inventive；全部肯定 → inventive；矛盾或无出现 → undefined。
 *
 * 局限（计划文档认可的启发式）：引述审查员否定意见的句子（如"审查员认为不具备创造性，
 * 但本申请具备创造性"）会同时计入正反 → undefined → 得 0 分；如需更稳可做末句加权。
 */
export function extractActualDirection(text: string): "inventive" | "not_inventive" | undefined {
  const posTotal = [...text.matchAll(POSITIVE_PHRASE_RE)].length;
  NEGATED_PHRASE_RE.lastIndex = 0;
  const negCount = [...text.matchAll(NEGATED_PHRASE_RE)].length;
  const posCount = Math.max(0, posTotal - negCount);
  if (negCount > 0 && posCount === 0) return "not_inventive";
  if (posCount > 0 && negCount === 0) return "inventive";
  return undefined; // 矛盾（正反并存）或无方向表述
}
