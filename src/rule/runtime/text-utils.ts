/**
 * 宪法规则引擎 — 中文文本处理共享工具。
 *
 * 统一 `hasNegationContext`（否定语境检测）与 `parseCnNumber`（中文数字解析），
 * 供 RuleEngine / synonym-engine / patent quality-gate 复用，避免三处镜像实现漂移。
 */

// ---------------------------------------------------------------------------
// hasNegationContext
// ---------------------------------------------------------------------------

/** 否定语境词（与 src/patent/quality-gate.ts 的 NEGATION_WORDS 保持同步镜像；不含单字"不/未/无"以免误放行）。 */
export const DEFAULT_NEGATION_WORDS: readonly string[] = [
  "防止",
  "避免",
  "不用于",
  "排除",
  "禁止",
  "不为",
  "非用于",
  "不构成",
  "区别于",
  "不属于",
];

/** 否定语境检查窗口（命中词前多少个字符）。 */
export const DEFAULT_NEGATION_WINDOW = 24;

/**
 * 否定词被吞入的复合词：这些词含否定词但语义不是否定（"无可避免的侵权"仍是
 * 对侵权的肯定陈述）。匹配时跳过落在这些复合词内的否定词命中。
 * 实现：命中前 2 字符与复合词前缀（"无可"/"不可"）比对即可覆盖全部复合词。
 */
const NEGATION_COMPOUNDS = ["无可避免", "不可避免"];

/**
 * 句子/子句边界符：窗口内出现任一边界符时，否定词视为属于上一句，不再影响本句。
 * （含中英文句号/分号、叹号、问号、换行、省略号、破折号；不含逗号——中文逗号
 * 连接的两个子句否定语境可跨逗号延续，如"本方案避免侵权，因而不构成侵权"。）
 */
const SENTENCE_BOUNDARIES = ["。", "；", ";", "！", "？", "?", "!", "\n", "…", "—"];

export type NegationContextOptions = {
  /** 否定语境检查窗口（默认 DEFAULT_NEGATION_WINDOW）。 */
  window?: number;
  /** 否定语境词表（默认 DEFAULT_NEGATION_WORDS）。 */
  negationWords?: readonly string[];
};

/** 在命中位置前查找否定语境：窗口内出现否定词且无句界分隔。 */
export function hasNegationContext(text: string, matchStart: number, options?: NegationContextOptions): boolean {
  const windowSize = options?.window ?? DEFAULT_NEGATION_WINDOW;
  const words = options?.negationWords ?? DEFAULT_NEGATION_WORDS;
  const start = Math.max(0, matchStart - windowSize);
  const window = text.slice(start, matchStart);
  if (SENTENCE_BOUNDARIES.some(b => window.includes(b))) return false;
  for (const word of words) {
    let searchFrom = 0;
    while (true) {
      const idx = window.indexOf(word, searchFrom);
      if (idx < 0) break;
      // 复合词吞入检查：命中词若落进 NEGATION_COMPOUNDS（无可避免/不可避免），
      // 其前缀（"无可"/"不可"）直接拼在命中前——跳过该命中
      // （"使用无可避免的侵权风险"中的"避免"不是否定语境）。
      const before2 = window.slice(Math.max(0, idx - 2), idx);
      if (NEGATION_COMPOUNDS.some(c => c.startsWith(`${before2}${word}`))) {
        searchFrom = idx + word.length;
        continue;
      }
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseCnNumber
// ---------------------------------------------------------------------------

const CN_DIGITS: Record<string, number> = {
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

const CN_UNITS: Record<string, number> = {
  十: 10,
  百: 100,
  千: 1000,
};

/**
 * 中文数字 → 阿拉伯数字。支持十/百/千位组合与零占位（"第一百零二条" → 102，
 * "一千二百三十四" → 1234）；"十"开头按 10 计（"第十条" → 10）。
 * 阿拉伯数字直接返回；含非法字符返回 null。
 */
export function parseCnNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  let total = 0;
  let digit = 0;
  for (const ch of trimmed) {
    if (ch in CN_UNITS) {
      total += (digit || 1) * CN_UNITS[ch]!;
      digit = 0;
    } else if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]!;
    } else {
      return null;
    }
  }
  return total + digit;
}
