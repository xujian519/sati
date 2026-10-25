/**
 * mapping 状态机（纯函数）：行级场景合法性 + 跨行法理推导
 * （新颖性单篇全覆盖、区别特征提取 —— 三步法第二步的输入）。
 */

import type { ChartMode, ChartRow, ChartTarget, ClaimElement } from "../protocol/types.js";

const PRIOR_ART_ONLY = new Set(["anticipation", "obviousness-combination"]);
const COVERED_MAPPINGS = new Set(["literal", "anticipation", "literal-construction-dependent"]);
const DISTINGUISHING_MAPPINGS = new Set(["not-found", "needs-evidence"]);

export type NoveltyCoverage = {
  covered: boolean;
  /** 已评估且不构成覆盖的要素（not-found / needs-evidence / partial 等）。 */
  missing: string[];
  /** 尚未评估的要素（无映射行或显式 unevaluated），不计入 missing。 */
  unevaluated: string[];
};

export type DistinguishingFeatures = {
  /** 主目标上未找到/证据不足的要素（保持只来自这两档）。 */
  features: string[];
  /** 主目标上尚未评估的要素，不当作区别特征。 */
  unevaluatedElements: string[];
};

function assessedElementIds(rows: ChartRow[], targetId: string): Set<string> {
  return new Set(rows.filter(r => r.targetId === targetId && r.mapping !== "unevaluated").map(r => r.elementId));
}

/** 行级合法性：返回违规描述列表（空 = 合法）。 */
export function validateRowMapping(row: ChartRow, target: ChartTarget | undefined, mode: ChartMode): string[] {
  const errors: string[] = [];
  // unevaluated 是「确无结论」的显式取值，不绑定目标类型或场景；
  // 空 quote / pinCite 由 chart 原子放行（空串表示未提供定位）。
  if (PRIOR_ART_ONLY.has(row.mapping) && target?.kind !== "prior-art") {
    errors.push(`行 [${row.elementId}→${row.targetId}] 的 mapping "${row.mapping}" 仅适用于 prior-art 目标`);
  }
  if (row.mapping === "doe" && mode !== "infringement") {
    errors.push(`行 [${row.elementId}→${row.targetId}] 的 mapping "doe" 仅适用于侵权模式`);
  }
  return errors;
}

/** 新颖性（单独对比）：目标上每个要素须 mapped（单篇全覆盖，专利法 A22.2）。 */
export function deriveNoveltyCoverage(rows: ChartRow[], targetId: string, elements: ClaimElement[]): NoveltyCoverage {
  const coveredIds = new Set(
    rows.filter(r => r.targetId === targetId && COVERED_MAPPINGS.has(r.mapping)).map(r => r.elementId),
  );
  const assessedIds = assessedElementIds(rows, targetId);
  const missing: string[] = [];
  const unevaluated: string[] = [];
  for (const element of elements) {
    if (coveredIds.has(element.id)) continue;
    if (assessedIds.has(element.id)) missing.push(element.id);
    else unevaluated.push(element.id);
  }
  return { covered: missing.length === 0 && unevaluated.length === 0, missing, unevaluated };
}

/** 区别特征 = 主目标（D1）上未找到的要素（供三步法第二步与 draft-claims 规避布局）。 */
export function deriveDistinguishingFeatures(
  rows: ChartRow[],
  primaryTargetId: string,
  elements: ClaimElement[],
): DistinguishingFeatures {
  const missing = new Set(
    rows.filter(r => r.targetId === primaryTargetId && DISTINGUISHING_MAPPINGS.has(r.mapping)).map(r => r.elementId),
  );
  const assessedIds = assessedElementIds(rows, primaryTargetId);
  return {
    features: elements.filter(el => missing.has(el.id)).map(el => el.id),
    unevaluatedElements: elements.filter(el => !assessedIds.has(el.id)).map(el => el.id),
  };
}
