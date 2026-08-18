/**
 * src/patent/spec — 说明书确定性检查纯函数（共享层）。
 *
 * 从 `src/tool/builtin/validateSpecification.ts` 下沉：数值范围端点/中间值实施例、
 * 效果数据定量性等检查为纯函数（零依赖），供 tool 层（validate_specification）与
 * patent 层（enablement 子图 spec_prechecks 节点）共同复用，避免跨层反向依赖
 * （src/patent/ 不得依赖 src/tool/）。
 */

// =============================================================================
// 数值范围与单位（端点 + 中间值实施例检测）
// =============================================================================

/**
 * 支持的单位列表（按长度降序排列：多字符单位在前，避免交替匹配把
 * "5mg" 截成 "m"、"0.1-2MPa" 截成 "m" 等误解析）。
 */
export const UNITS = "°C|℃|MPa|kPa|Pa|rpm|min|mol|mm|cm|kg|mg|ml|mL|％|°|m|g|L|h|s|%";

/** 数值范围（如 20-90℃、20℃至90℃、20~90℃）。 */
const RANGE_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(?:${UNITS})?\\s*(?:[~～至\\-—])\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`,
  "g",
);

/** 带单位的单个数值（如 60℃、5mm）。 */
const VALUE_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`, "g");

export type NumericRange = { min: number; max: number; unit: string };

/** 归一化单位：温度类统一为 "°"，其余原样（℃/°C/° 可比）。 */
export function normalizeUnit(unit: string): string {
  return ["℃", "°C", "°"].includes(unit) ? "°" : unit;
}

/** 提取说明书中的数值范围（min < max 才保留）。 */
export function extractNumericRanges(text: string): NumericRange[] {
  const ranges: NumericRange[] = [];
  let m: RegExpExecArray | null;
  RANGE_PATTERN.lastIndex = 0;
  while ((m = RANGE_PATTERN.exec(text)) !== null) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
      ranges.push({ min, max, unit: normalizeUnit(m[3] ?? "") });
    }
  }
  return ranges;
}

/** 提取正文中出现的带单位单个数值（剔除范围表达式自身，避免把端点当独立数值）。 */
export function extractNumericValues(text: string): Array<{ value: number; unit: string }> {
  const body = text.replace(RANGE_PATTERN, " ");
  const values: Array<{ value: number; unit: string }> = [];
  let m: RegExpExecArray | null;
  VALUE_PATTERN.lastIndex = 0;
  while ((m = VALUE_PATTERN.exec(body)) !== null) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) values.push({ value, unit: normalizeUnit(m[2] ?? "") });
  }
  return values;
}

/** 数值范围端点 + 中间值实施例检测：返回 (缺端点范围, 缺中间值范围)。 */
export function checkNumericRangeCoverage(text: string): {
  endpointMissing: NumericRange[];
  midpointMissing: NumericRange[];
} {
  const ranges = extractNumericRanges(text);
  const values = extractNumericValues(text);
  const endpointMissing: NumericRange[] = [];
  const midpointMissing: NumericRange[] = [];
  for (const range of ranges) {
    const sameUnit = values.filter(v => v.unit === range.unit);
    const hasEndpoint = sameUnit.some(v => v.value === range.min || v.value === range.max);
    const hasMidpoint = sameUnit.some(v => v.value > range.min && v.value < range.max);
    if (!hasEndpoint) endpointMissing.push(range);
    if (!hasMidpoint) midpointMissing.push(range);
  }
  return { endpointMissing, midpointMissing };
}

/** 格式化数值范围为显示文本（"20-90℃"）。 */
export function formatRange(range: NumericRange): string {
  return `${range.min}-${range.max}${range.unit === "°" ? "℃" : range.unit}`;
}

// =============================================================================
// 效果数据定量性检测
// =============================================================================

/** 无定量数据支撑的效果套话模式（"效果好/显著/大幅提升"等）。 */
const VAGUE_EFFECT_RE =
  /(?:效果|性能)(?:显著|良好|优异|优越|极佳|大幅|大大提高|明显提升|显著提高|大幅提升|明显改善|显著改善|明显|好)|(?:大大|显著|明显|大幅|有效)(?:提高|提升|改善|降低|减少|增强)/;

/** 返回未附带任何数字/百分比的"效果套话"句子（截断 40 字）。 */
export function checkEffectQuantification(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split(/[。；\n]/)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    if (VAGUE_EFFECT_RE.test(sentence) && !/\d|％|%/.test(sentence)) {
      hits.push(sentence.slice(0, 40));
    }
  }
  return hits;
}
