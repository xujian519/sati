/**
 * 配置校验原语（跨模块共享）。
 *
 * 只放「判定 + 收窄」的纯函数，不做诊断上报、不决定回退值——诊断 code/message
 * 与 fallback 属于各配置模块自己的语义，#811 的重复点正是这些判定逻辑。
 */

/** 有限正数；`0`、负数、`NaN`、`Infinity` 均不通过。 */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 有限非负数。 */
export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 有限正整数。 */
export function isPositiveInteger(value: unknown): value is number {
  return isPositiveNumber(value) && Number.isInteger(value);
}

/** 有限非负整数。 */
export function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

/** 非空字符串（去首尾空白后仍非空）；返回裁剪后的值。 */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 正数，向下取整（用于外部工具回报的行/列等可能带小数的数值）。 */
export function asFlooredPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

/** 正数，否则 `undefined`（配置读取的便捷形态）。 */
export function asPositiveNumber(value: unknown): number | undefined {
  return isPositiveNumber(value) ? value : undefined;
}
