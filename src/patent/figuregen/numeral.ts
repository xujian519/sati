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
 * 数字档排除前缀：这些词后的数字是编号（式(1)/步骤(2)/实施例3/图4…），不是附图标记。
 * 末尾允许空白与一个左括号（`式（1）`/`图 2`）。
 */
export const NUMERAL_PREFIX_EXCLUSION =
  /(?:式|公式|步骤|例|图|表|第|共|约|款|条|项|章|节|claim|step|formula|fig)\s*[（(]?\s*$/iu;

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
