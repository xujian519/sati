/**
 * gap 检测（纯函数）：聚合证据薄弱的行，产出第一优先输出 gap list。
 *
 * 四档缺口：not-found / needs-evidence / partial / unevaluated。
 * `unevaluated` 由「要素 × 目标」中缺失的映射组合产生，或由模型显式标注；
 * 它和「查过但没有」分属不同出口，回退与规划才能知道哪一块没跑过。
 */

import type { ChartRow, ChartTarget, ClaimElement, GapEntry, Mapping } from "../protocol/types.js";

type GapMapping = Extract<Mapping, "not-found" | "needs-evidence" | "partial" | "unevaluated">;

const GAP_MAPPINGS: ReadonlySet<Mapping> = new Set<Mapping>(["not-found", "needs-evidence", "partial", "unevaluated"]);

// 四表键集合由 GapMapping 在类型层强制同步：漏扩任一表即 tsc 报错。
const PRIORITY: Record<GapMapping, number> = {
  "not-found": 0,
  "needs-evidence": 1,
  partial: 2,
  // 未评估排在最后：已知缺口更可操作，不应被「还没看」淹没。
  unevaluated: 3,
};

const SUGGESTIONS: Record<GapMapping, string> = {
  "not-found": "补充检索或论证等同替换",
  "needs-evidence": "证据固化（全文引用/附图标记）",
  partial: "补充公开部分的精确定位（pin-cite）",
  unevaluated: "补做该要素对该目标的映射评估",
};

/** 缺口原因文案（与 SUGGESTIONS 并列：前者为建议动作，本表为存在缺口的原因）。 */
const GAP_REASON_LABELS: Record<GapMapping, string> = {
  "not-found": "未找到对应内容",
  "needs-evidence": "证据不足",
  partial: "仅部分公开",
  unevaluated: "未评估",
};

function isGapMapping(mapping: Mapping): mapping is GapMapping {
  return GAP_MAPPINGS.has(mapping);
}

/**
 * @param rows 已有映射行。
 * @param elements 已拆分要素（用于枚举缺失的「要素 × 目标」组合）。
 * @param targets 映射目标。
 */
export function detectGaps(rows: ChartRow[], elements: ClaimElement[], targets: ChartTarget[]): GapEntry[] {
  const gaps: GapEntry[] = [];
  const seenPairs = new Set<string>();
  const pairKey = (elementId: string, targetId: string): string => `${elementId}\u0000${targetId}`;

  const push = (elementId: string, targetId: string, mapping: GapMapping): void => {
    const key = pairKey(elementId, targetId);
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    gaps.push({
      elementId,
      targetId,
      mapping,
      reason: `要素 ${elementId} 在 ${targetId} 上${GAP_REASON_LABELS[mapping]}`,
      suggestion: SUGGESTIONS[mapping],
    });
  };

  const rowByPair = new Map<string, ChartRow>();
  for (const row of rows) {
    const key = pairKey(row.elementId, row.targetId);
    if (!rowByPair.has(key)) rowByPair.set(key, row);
  }

  // 未评估：枚举「要素 × 目标」，没有映射行或显式标 unevaluated 的组合都算。
  for (const element of elements) {
    for (const target of targets) {
      const row = rowByPair.get(pairKey(element.id, target.id));
      if (row === undefined || row.mapping === "unevaluated") {
        push(element.id, target.id, "unevaluated");
      }
    }
  }

  // 已有行的缺口：三档已知缺口 + 显式 unevaluated（后者覆盖 elements/targets 未传入的行）。
  for (const row of rows) {
    const mapping = row.mapping;
    if (isGapMapping(mapping)) push(row.elementId, row.targetId, mapping);
  }

  gaps.sort((a, b) => {
    const aPriority = isGapMapping(a.mapping) ? PRIORITY[a.mapping] : Number.MAX_SAFE_INTEGER;
    const bPriority = isGapMapping(b.mapping) ? PRIORITY[b.mapping] : Number.MAX_SAFE_INTEGER;
    return aPriority - bPriority;
  });
  return gaps;
}
