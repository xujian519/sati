/**
 * 附图标记（reference numeral）的词法边界：编号前缀排除与取值范围。
 *
 * 两处必须共用一份：
 * - 图→文核验（V2）判断"说明书是否提及标记 20"；
 * - 说明书侧的标记抽取（`figure/validator.ts`）判断"哪些数字是附图标记"。
 *
 * 各写一份会让同一条文本在两个方向上得到不同答案（例如 `步骤20` 被 V2 当成提及、
 * 却被抽取侧排除），而两处各有测试，改一侧不会让另一侧变红。
 */

/**
 * 回看窗口（字符）：须容纳最长前缀（`formula `、`实施例`、`如附图`）。
 * 窗口写小了英文前缀会整类失效（`claim `/`FIG. ` 放不进 4 字符），而规则本身看着是对的。
 */
const NUMERAL_PREFIX_WINDOW = 24;

/**
 * 专用编号词：不作元件名后缀，出现即判为编号（允许句点、空白与一个左括号）。
 *
 * `式` 在此列（`式(1)`/`计算式(2)` 是公式号），但排除 `方式`/`形式`/`样式`/`模式`/`程式`
 * 这些以它结尾的名词——「连接方式(20)」里的 20 是附图标记，误排除会让 V2 直接判 fail。
 */
const STRONG_PREFIX =
  /(?:(?<![方形样模程])式|公式|步骤|实施例|第|共|约|claims?|steps?|formula|figures?|fig)\.?\s*[（(]?\s*$/iu;

/**
 * 单字编号词：同时也是常见元件名结尾（视图/水表/密封条/万向节/比例），故只在左侧是
 * 边界（行首、标点、空白）、图示引用词（如/见/参/附/前后上下本该此其）或虚词
 * （与/和/及/或/在/由/对/至/从/把/将/的）之后才排除。
 *
 * 少了这条约束，`所述密封条（20）` 会被判成"未提及标记 20"，V2 直接误报 fail。
 */
const SOFT_PREFIX =
  /(?:^|[，。；：、,.;:!?（）()〔〕【】[\]「」“”"'《》\s如见参附前后上下本该此其与和及或在由对至从把将的])(?:图|表|条|项|章|节|款|例)\s*[（(]?\s*$/u;

/**
 * 数字前文是否以编号词收尾（是则这个数字不是附图标记）。
 *
 * @param textBeforeNumeral - 该数字在说明书原文中的**前文**（可含前文全部，函数自己取窗口）。
 */
export function hasNumeralPrefix(textBeforeNumeral: string): boolean {
  const window = textBeforeNumeral.slice(-NUMERAL_PREFIX_WINDOW);
  return STRONG_PREFIX.test(window) || SOFT_PREFIX.test(window);
}

/**
 * 该数字是否可能是附图标记（正整数）。
 *
 * 上界只做**提示性**判断：三位数是实务常见上限，四位及以上的数字更可能是年份/页码/段号，
 * 但条文未规定上限，故 V22 对超上限只判 warn。
 */
export function isRefNumeral(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** 附图标记的常用三位数上限（超出时 V22 提示复核，不判违规）。 */
export const REF_NUMERAL_PRACTICAL_MAX = 999;
