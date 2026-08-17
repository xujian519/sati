/**
 * src/patent/graph/domains/citation-check — 引用真实性校验（纯函数，无 LLM 依赖）。
 *
 * 校验创造性结论中引用的对比文件（D1/D2）是否真实出现在检索结果 prior_art 中，
 * 杜绝模型幻觉引用。提取规则（对齐 2026-08-17 创造性优化计划 P1-2）：
 * - 优先用专利号正则（如 US11452699B2）从 document / candidate_documents 提取；
 * - hint.evidence 为自由文本时仅提取专利号，不做标题/段落硬匹配；
 * - 无专利号时回退提取文档标识（对比文件N / 证据N / D<N>）做归一比对；
 * - prior_art 为空/检索降级时跳过硬校验（不双重惩罚）。
 */

/**
 * 专利号正则（国家代码 2 位 + 1-14 位数字 + 可选类型后缀）。
 * 已知误匹配面（计划文档认可"仅提取专利号"决策）：ZL 前缀的中国实用新型
 * （"ZL201311234567.X" 会截掉 ".X" 后缀）、自由文本中的 "IP2022" 类 token；
 * 引用侧与文档侧共用同一提取器，接地判定仍自洽，仅可能产生个别误报"未接地"。
 */
export const PATENT_NUMBER_RE = /[A-Z]{2}\d{1,14}[A-Z]?\d*/g;

/** 文档标识正则（对比文件2 / 证据1 / D3；D 标识前后须为非字母数字字符，兼容 JSON 键内提取）。 */
const DOC_LABEL_RES = [/(?:对比文件|证据)\s*(\d+)/g, /(?:^|[^\p{L}\p{N}])D(\d+)(?=$|[^\p{L}\p{N}])/gu];

/** 从文本提取引用标识：专利号优先；无专利号时归一文档标识（对比文件2 → D2）。 */
export function extractCitationIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(PATENT_NUMBER_RE)) ids.push(m[0]);
  if (ids.length > 0) return [...new Set(ids)];
  for (const re of DOC_LABEL_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const n = m[1] ?? m[2];
      if (n !== undefined) ids.push(`D${n}`);
    }
  }
  return [...new Set(ids)];
}

/** 从单篇检索命中提取标识（title + url + 可选 patent 字段）。 */
export function extractDocIds(doc: unknown): string[] {
  if (doc === null || typeof doc !== "object") return [];
  const record = doc as Record<string, unknown>;
  const parts = [record.title, record.url, record.patent].filter(v => typeof v === "string").join(" ");
  return extractCitationIds(parts);
}

/** 引用是否接地：与某篇检索命中标识相等或互相包含（url 常带路径尾缀）。 */
function isGrounded(refId: string, docIds: string[]): boolean {
  return docIds.some(d => d === refId || d.includes(refId) || refId.includes(d));
}

export type CitationCheckResult = {
  grounded: boolean;
  uncited: string[];
  report: string;
};

/**
 * 校验引用真实性：refTexts 中提取的引用标识须全部在 docs 中接地。
 * 无法校验（无引用标识 / 无检索命中标识）时放行并写说明，不误报。
 */
export function checkCitations(opts: { refTexts: readonly string[]; docs: readonly unknown[] }): CitationCheckResult {
  const { refTexts, docs } = opts;
  if (docs.length === 0) {
    return { grounded: true, uncited: [], report: "引用真实性校验：检索结果为空，跳过硬校验" };
  }
  const refIds = extractCitationIds(refTexts.filter(t => typeof t === "string" && t.trim().length > 0).join("\n"));
  if (refIds.length === 0) {
    return {
      grounded: true,
      uncited: [],
      report: "引用真实性校验：未提取到可校验的引用标识（专利号或文档标识），跳过硬校验",
    };
  }
  const docIds = docs.flatMap(extractDocIds);
  if (docIds.length === 0) {
    return {
      grounded: true,
      uncited: [],
      report: "引用真实性校验：检索结果无法提取标识（无专利号/文档标识），跳过硬校验",
    };
  }
  const uncited = refIds.filter(refId => !isGrounded(refId, docIds));
  if (uncited.length === 0) {
    return { grounded: true, uncited: [], report: `引用真实性校验：引用全部接地（${refIds.join("、")}）` };
  }
  return {
    grounded: false,
    uncited,
    report: `引用真实性校验：以下引用未在检索结果中找到对应对比文件: ${uncited.join("、")}（需核实引用或补充检索）`,
  };
}
