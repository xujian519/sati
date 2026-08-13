/**
 * gap 检测（纯函数）：聚合证据薄弱的行，产出第一优先输出 gap list。
 */

import type { ChartRow, GapEntry } from "../protocol/types.js";

const GAP_MAPPINGS = new Set(["not-found", "needs-evidence", "partial"]);

const PRIORITY: Record<string, number> = { "not-found": 0, "needs-evidence": 1, partial: 2 };

const SUGGESTIONS: Record<string, string> = {
  "not-found": "补充检索或论证等同替换",
  "needs-evidence": "证据固化（全文引用/附图标记）",
  partial: "补充公开部分的精确定位（pin-cite）",
};

export function detectGaps(rows: ChartRow[]): GapEntry[] {
  const gaps: GapEntry[] = [];
  for (const row of rows) {
    if (!GAP_MAPPINGS.has(row.mapping)) continue;
    const mapping = row.mapping as "not-found" | "needs-evidence" | "partial";
    gaps.push({
      elementId: row.elementId,
      targetId: row.targetId,
      mapping,
      reason: `要素 ${row.elementId} 在 ${row.targetId} 上${mapping === "not-found" ? "未找到对应内容" : mapping === "needs-evidence" ? "证据不足" : "仅部分公开"}`,
      suggestion: SUGGESTIONS[mapping] ?? "",
    });
  }
  gaps.sort((a, b) => (PRIORITY[a.mapping] ?? 9) - (PRIORITY[b.mapping] ?? 9));
  return gaps;
}
