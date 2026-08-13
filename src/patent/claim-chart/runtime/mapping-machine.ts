/**
 * mapping 状态机（纯函数）：行级场景合法性 + 跨行法理推导
 * （新颖性单篇全覆盖、区别特征提取 —— 三步法第二步的输入）。
 */

import type { ChartMode, ChartRow, ChartTarget, ClaimElement } from "../protocol/types.js";

const PRIOR_ART_ONLY = new Set(["anticipation", "obviousness-combination"]);
const COVERED_MAPPINGS = new Set(["literal", "anticipation", "literal-construction-dependent"]);
const DISTINGUISHING_MAPPINGS = new Set(["not-found", "needs-evidence"]);

/** 行级合法性：返回违规描述列表（空 = 合法）。 */
export function validateRowMapping(row: ChartRow, target: ChartTarget | undefined, mode: ChartMode): string[] {
  const errors: string[] = [];
  if (PRIOR_ART_ONLY.has(row.mapping) && target?.kind !== "prior-art") {
    errors.push(`行 [${row.elementId}→${row.targetId}] 的 mapping "${row.mapping}" 仅适用于 prior-art 目标`);
  }
  if (row.mapping === "doe" && mode !== "infringement") {
    errors.push(`行 [${row.elementId}→${row.targetId}] 的 mapping "doe" 仅适用于侵权模式`);
  }
  return errors;
}

/** 新颖性（单独对比）：目标上每个要素须 mapped（单篇全覆盖，专利法 A22.2）。 */
export function deriveNoveltyCoverage(
  rows: ChartRow[],
  targetId: string,
  elements: ClaimElement[],
): { covered: boolean; missing: string[] } {
  const coveredIds = new Set(
    rows.filter(r => r.targetId === targetId && COVERED_MAPPINGS.has(r.mapping)).map(r => r.elementId),
  );
  const missing = elements.filter(el => !coveredIds.has(el.id)).map(el => el.id);
  return { covered: missing.length === 0, missing };
}

/** 区别特征 = 主目标（D1）上未找到的要素（供三步法第二步与 draft-claims 规避布局）。 */
export function deriveDistinguishingFeatures(
  rows: ChartRow[],
  primaryTargetId: string,
  elements: ClaimElement[],
): string[] {
  const missing = new Set(
    rows.filter(r => r.targetId === primaryTargetId && DISTINGUISHING_MAPPINGS.has(r.mapping)).map(r => r.elementId),
  );
  return elements.filter(el => missing.has(el.id)).map(el => el.id);
}
