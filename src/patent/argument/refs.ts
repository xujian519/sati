/**
 * 论证引用（ArgumentRef）的不变量与统一缺口去重。
 *
 * 三套结构（claim-chart 要素 / syllogism 事实+法条 / claim-binding 结论）各自保留
 * 存储格式，只在这里共用「至少一个字段非空」的判据与缺口合并规则。
 */

import type { ArgumentGap, ArgumentRef } from "./types.js";

/** 三向指针的字段顺序（规范化与去重键共用；顺序变化会让同一引用算出不同键）。 */
const REF_FIELDS = ["elementId", "factRef", "articleRef"] as const;

export class ArgumentRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentRefError";
  }
}

/** 去空白、丢弃空字段；三个字段都为空时返回 undefined。 */
export function normalizeArgumentRef(ref: ArgumentRef): ArgumentRef | undefined {
  const normalized: ArgumentRef = {};
  for (const field of REF_FIELDS) {
    const value = ref[field];
    if (typeof value === "string" && value.trim() !== "") normalized[field] = value.trim();
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** 校验不变量「至少一个字段非空」，返回规范化后的引用；空引用抛 ArgumentRefError。 */
export function assertArgumentRef(ref: ArgumentRef, context = "ArgumentRef"): ArgumentRef {
  const normalized = normalizeArgumentRef(ref);
  if (normalized === undefined) {
    throw new ArgumentRefError(`${context} 至少需要一个非空字段（elementId / factRef / articleRef）`);
  }
  return normalized;
}

/** 规范化序列化：字段按固定顺序，供去重/比较使用。 */
export function argumentRefKey(ref: ArgumentRef): string {
  const normalized = assertArgumentRef(ref);
  return REF_FIELDS.map(field => normalized[field] ?? "").join("\u0000");
}

/**
 * 统一缺口去重：键 = 规范化 ref + kind。
 *
 * 同一缺口被两套结构同时报出时 `source` 不同也视为同一条，保留首条（含 detail），
 * 把来源并入 `sources`（首条也写，便于消费方按同一形状读取）。
 */
export function dedupeArgumentGaps(gaps: readonly ArgumentGap[]): ArgumentGap[] {
  const result: ArgumentGap[] = [];
  const byKey = new Map<string, ArgumentGap>();
  for (const gap of gaps) {
    const ref = assertArgumentRef(gap.ref, `缺口 ${gap.kind}`);
    const key = `${argumentRefKey(ref)}\u0000${gap.kind}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      const entry: ArgumentGap = { ...gap, ref, sources: [gap.source] };
      byKey.set(key, entry);
      result.push(entry);
      continue;
    }
    const sources = existing.sources ?? [existing.source];
    if (!sources.includes(gap.source)) existing.sources = [...sources, gap.source];
  }
  return result;
}
