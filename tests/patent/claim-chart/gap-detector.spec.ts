import assert from "node:assert/strict";
import test from "node:test";
import { detectGaps } from "../../../src/patent/claim-chart/runtime/gap-detector.js";
import type { ChartRow, ChartTarget, ClaimElement } from "../../../src/patent/claim-chart/protocol/types.js";

function row(elementId: string, targetId: string, mapping: ChartRow["mapping"]): ChartRow {
  return { elementId, targetId, quote: "", pinCite: "", mapping, state: mapping, verified: false };
}

const ELEMENTS: ClaimElement[] = [
  { id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" },
  { id: "1b", claimNo: 1, text: "和滤芯", kind: "limitation" },
  { id: "1c", claimNo: 1, text: "所述滤芯含有活性炭", kind: "limitation" },
];

const D1: ChartTarget = { id: "D1", kind: "prior-art" };
const D2: ChartTarget = { id: "D2", kind: "prior-art" };

test("无缺口时返回空列表", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "anticipation"), row("1c", "D1", "literal")];
  assert.deepEqual(detectGaps(rows, ELEMENTS, [D1]), []);
});

test("聚合缺口并按优先级排序（not-found > needs-evidence > partial）", () => {
  const rows = [row("1a", "D1", "partial"), row("1b", "D1", "needs-evidence"), row("1c", "D1", "not-found")];
  const gaps = detectGaps(rows, [], []);
  assert.deepEqual(
    gaps.map(g => `${g.elementId}:${g.mapping}`),
    ["1c:not-found", "1b:needs-evidence", "1a:partial"],
  );
});

test("缺口条目带建议动作", () => {
  const gaps = detectGaps([row("1a", "D1", "not-found"), row("1b", "D1", "needs-evidence")], [], []);
  assert.equal(gaps[0]!.suggestion, "补充检索或论证等同替换");
  assert.equal(gaps[1]!.suggestion, "证据固化（全文引用/附图标记）");
});

test("缺失的「要素 × 目标」组合产出 unevaluated", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "literal")];
  const gaps = detectGaps(rows, ELEMENTS, [D1]);
  assert.deepEqual(
    gaps.map(g => `${g.elementId}:${g.targetId}:${g.mapping}`),
    ["1c:D1:unevaluated"],
  );
  assert.match(gaps[0]!.reason, /未评估/);
  assert.equal(gaps[0]!.suggestion, "补做该要素对该目标的映射评估");
});

test("unevaluated 不进入 not-found 桶", () => {
  const rows = [row("1a", "D1", "not-found"), row("1b", "D1", "literal")];
  const gaps = detectGaps(rows, ELEMENTS, [D1]);
  assert.deepEqual(
    gaps.map(g => `${g.elementId}:${g.mapping}`),
    ["1a:not-found", "1c:unevaluated"],
  );
});

test("四档缺口同图共存，未评估排在最后", () => {
  const elements: ClaimElement[] = [
    ...ELEMENTS,
    { id: "1d", claimNo: 1, text: "其中所述壳体为塑料", kind: "limitation" },
  ];
  const rows = [row("1a", "D1", "not-found"), row("1b", "D1", "needs-evidence"), row("1c", "D1", "partial")];
  const gaps = detectGaps(rows, elements, [D1]);
  assert.deepEqual(
    gaps.map(g => g.mapping),
    ["not-found", "needs-evidence", "partial", "unevaluated"],
  );
  assert.equal(gaps[3]!.elementId, "1d");
});

test("显式 unevaluated 行产出缺口且不与缺失枚举重复计数", () => {
  const rows = [row("1a", "D1", "unevaluated")];
  const gaps = detectGaps(rows, [ELEMENTS[0]!], [D1]);
  assert.deepEqual(
    gaps.map(g => `${g.elementId}:${g.mapping}`),
    ["1a:unevaluated"],
  );
});

test("同一对的多行缺口只计一次", () => {
  const rows = [row("1a", "D1", "partial"), row("1a", "D1", "not-found")];
  const gaps = detectGaps(rows, [ELEMENTS[0]!], [D1]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.mapping, "partial"); // 首行胜出，排序不制造重复项
});

test("多个目标分别枚举缺失组合", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "literal")];
  const gaps = detectGaps(rows, [ELEMENTS[0]!, ELEMENTS[1]!], [D1, D2]);
  assert.deepEqual(
    gaps.map(g => `${g.elementId}:${g.targetId}:${g.mapping}`),
    ["1a:D2:unevaluated", "1b:D2:unevaluated"],
  );
});
