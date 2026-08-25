/**
 * src/knowledge/legal — 法条/条款确定性解析（A1）。
 *
 * 对齐 claim-chart「要素级」哲学：检索命中 knowledge.db 的 law_article 时，
 * chunks 是 XiaoNuo 按大小合并的块（一条 chunk 可含多条法条，如"第一条…至第五条"），
 * 本模块在 Sati 侧把合并块按「第N条」行首重新切成单条，并归一化条号
 * （阿拉伯/中文两套 id + 修复"第第一条"缺陷），供检索结果定位到条而非整篇。
 *
 * 纯函数、零依赖，可独立单测。
 */

/** 中文数字字符集（含 零/〇/两/两 与阿拉伯数字，用于条款号匹配）。 */
const CN_DIGITS = "零〇一二两三四五六七八九十百千0-9";

/** 条款标题行匹配：第N条、第N条之M（正文随行捕获）。 */
const ARTICLE_HEADING_RE = new RegExp(`^第([${CN_DIGITS}]+)条(?:之([${CN_DIGITS}]+))?[ \u3000]*(.*)$`);

/** 归一化用：剥离"第"前缀后的条号（如 "一条" / "一百二十条之一"）。 */
const ARTICLE_ID_RE = new RegExp(`^\\s*([${CN_DIGITS}]+)\\s*条(?:之\\s*([${CN_DIGITS}]+))?$`);

const CN_CHAR_VALUES: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CN_UNIT_VALUES: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1000,
};

/** 中文数字转阿拉伯（支持 零~九 + 十/百/千 组合；"十一"=11、"一百二十三"=123、"十"=10）。 */
export function cnToArabic(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  let total = 0;
  let current = 0;
  let hasValue = false;
  for (const ch of value) {
    const digit = CN_CHAR_VALUES[ch];
    const unit = CN_UNIT_VALUES[ch];
    if (digit !== undefined) {
      current = digit;
      hasValue = true;
    } else if (unit !== undefined) {
      if (!hasValue) current = 1; // 十/百/千 前无数字时视为 1 个单位（如 "十一" 的 "十"）
      total += current * unit;
      current = 0;
      hasValue = false;
    }
  }
  return total + current;
}

export type ArticleHeading = {
  /** 归一化母条号（阿拉伯数字，如 "第1条" / "第120条"）。 */
  base: string;
  /** 中文原文母条号（如 "第一条" / "第一百二十条"）。 */
  baseZh: string;
  /** 子条号（阿拉伯数字字符串，"第一百二十条之一" → "1"）；无则 undefined。 */
  sub?: string;
  /** 子条号中文原文（"第一百二十条之一" → "一"）；无则 undefined。 */
  subZh?: string;
  /** 条号之后的正文开头（同行剩余部分，去首尾空白）。 */
  text: string;
};

/**
 * 解析条款标题行：捕获「第N条」/「第N条之M」及同行正文。
 * 非条款标题（如 "目录"、章名、正文行）返回 null。
 */
export function parseArticleHeading(heading: string): ArticleHeading | null {
  const m = ARTICLE_HEADING_RE.exec(heading.trim());
  if (m === null) return null;
  const [, baseNum, subNum, rest] = m;
  const baseZh = `第${baseNum}条`;
  return {
    base: `第${cnToArabic(baseNum!)}条`,
    baseZh,
    ...(subNum !== undefined ? { sub: String(cnToArabic(subNum)), subZh: subNum } : {}),
    text: (rest ?? "").trim(),
  };
}

export type ArticleFragment = {
  /** 原始条款起始行（含条号与同行正文）。 */
  heading: string;
  /** 归一化完整条号（含子条，如 "第1条" / "第120条之一"）。 */
  number: string;
  /** 归一化母条号（不含子条，如 "第1条" / "第120条"）。 */
  base: string;
  /** 子条号（阿拉伯数字字符串）；无则 undefined。 */
  sub?: string;
  /** 条款正文（起始行同文 + 后续行合并，去首尾空白）。 */
  content: string;
};

/**
 * 对整篇法条/合并块文本做确定性条款切分：行首「第N条」开新条，其余行归入当前条。
 * 正文内非行首的"第X条"引用（如"依照本法第八条…"）不会误切。
 */
export function splitLawIntoArticles(fullText: string): ArticleFragment[] {
  const fragments: ArticleFragment[] = [];
  let current: ArticleFragment | null = null;
  for (const line of fullText.split(/\r?\n/)) {
    const parsed = parseArticleHeading(line);
    if (parsed !== null) {
      if (current !== null) fragments.push(current);
      const number = parsed.sub !== undefined ? `${parsed.base}之${parsed.sub}` : parsed.base;
      current = {
        heading: line.trim(),
        number,
        base: parsed.base,
        ...(parsed.sub !== undefined ? { sub: parsed.sub } : {}),
        content: parsed.text,
      };
    } else if (current !== null) {
      current.content += `\n${line}`;
    }
  }
  if (current !== null) fragments.push(current);
  return fragments;
}

/**
 * 归一化条号：接受阿拉伯/中文/含空格/"第第一条"等形态，输出标准 "第N条[之M]"。
 * 无法识别为条号时原样返回（trim 后）。
 */
export function normalizeArticleId(id: string): string {
  const cleaned = id.trim().replace(/^第+/, "");
  const m = ARTICLE_ID_RE.exec(cleaned);
  if (m === null) return id.trim();
  const sub = m[2] !== undefined ? `之${cnToArabic(m[2])}` : "";
  return `第${cnToArabic(m[1])}条${sub}`;
}

/** 由条款标题解析出 LawRecord 上的 article 字段（无标题/不可解析时为空对象）。 */
export function headingToArticleRecord(heading: string | null | undefined): {
  article?: string;
  articleBase?: string;
  subArticle?: string;
} {
  if (heading === null || heading === undefined) return {};
  const parsed = parseArticleHeading(heading);
  if (parsed === null) return {};
  return {
    // article 保留原文条号形态（"第一条"/"第一百二十条之一"），供模型/用户直接定位；
    // articleBase/subArticle 为阿拉伯归一化标识，供程序跨版本/跨库对齐。
    article: parsed.sub !== undefined ? `${parsed.baseZh}之${parsed.subZh}` : parsed.baseZh,
    articleBase: parsed.base,
    ...(parsed.sub !== undefined ? { subArticle: parsed.sub } : {}),
  };
}
