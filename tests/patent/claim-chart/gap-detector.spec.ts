import assert from "node:assert/strict";
import test from "node:test";
import { detectGaps } from "../../../src/patent/claim-chart/runtime/gap-detector.js";
import type { ChartRow } from "../../../src/patent/claim-chart/protocol/types.js";

function row(elementId: string, targetId: string, mapping: ChartRow["mapping"]): ChartRow {
  return { elementId, targetId, quote: "", pinCite: "", mapping, state: mapping, verified: false };
}

test("无缺口时返回空列表", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "anticipation")];
  assert.deepEqual(detectGaps(rows), []);
});

test("聚合缺口并按优先级排序（not-found > needs-evidence > partial）", () => {
  const rows = [
    row("1a", "D1", "partial"),
    row("1b", "D1", "needs-evidence"),
    row("1c", "D1", "not-found"),
    row("1c", "D2", "literal"),
  ];
  const gaps = detectGaps(rows);
  assert.deepEqual(
    gaps.map(g => `${g.elementId}:${g.mapping}`),
    ["1c:not-found", "1b:needs-evidence", "1a:partial"],
  );
});

test("缺口条目带建议动作", () => {
  const gaps = detectGaps([row("1a", "D1", "not-found"), row("1b", "D1", "needs-evidence")]);
  assert.equal(gaps[0]!.suggestion, "补充检索或论证等同替换");
  assert.equal(gaps[1]!.suggestion, "证据固化（全文引用/附图标记）");
});
