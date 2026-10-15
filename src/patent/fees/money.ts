/**
 * src/patent/fees/money — 官费金额算术（以「分」为整数单位）。
 *
 * 金额一律以**整数分**承载：官费表里全是 900、1200、2500、8000 这类整数元，加总与
 * 按比例减缴之后都不应出现浮点误差——`0.1 + 0.2 !== 0.3` 在一个案子的缴费单上就是
 * 一笔对不上的钱。元金额以十进制字符串进入（官费标准就是这么写的），一次解析成整数分。
 *
 * 百分数取整口径：四舍五入到分。本包的算术约定，在此声明一次，不在每个调用点重复。
 */

/** 十进制元金额：无符号、无指数、最多两位小数。 */
const YUAN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;

/**
 * 把十进制元金额解析为分。
 * @param value - 金额原文，如 `900`、`94.5`。
 * @returns 分；不是合法十进制元金额时返回 null。
 */
export function parseYuan(value: string): number | null {
  if (!YUAN.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const fen = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(fen) ? fen : null;
}

/**
 * 把分格式化为两位小数的元。
 * @param fen - 分。
 * @returns 元字符串，如 `94.50`。
 */
export function formatFen(fen: number): string {
  const sign = fen < 0 ? "-" : "";
  const absolute = Math.abs(fen);
  return `${sign}${String(Math.floor(absolute / 100))}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * 取一个金额的百分数。
 * @param fen - 基数（分）。
 * @param percent - 百分数；`100` 原样返回基数。
 * @returns 四舍五入到分的结果。
 */
export function applyPercent(fen: number, percent: number): number {
  return Math.round((fen * percent) / 100);
}

/**
 * 减缴 N% 之后应缴的金额。
 *
 * 语义在此定死一次：「减缴 85%」= 只缴 15%（`amount × (100 − 85) / 100`）。官费标准的
 * 减缴栏就是按这个口径印的（900 元 × 15% = 135 元），故不在调用点再作解释。
 * @param fen - 全额（分）。
 * @param reductionPercent - 减缴百分数。
 * @returns 应缴金额（分）。
 */
export function reducedFen(fen: number, reductionPercent: number): number {
  return applyPercent(fen, 100 - reductionPercent);
}

/**
 * 把分相加。
 * @param values - 待相加的分。
 * @returns 总和（分）。
 */
export function sumFen(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
