import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDistinguishingFeatures,
  deriveNoveltyCoverage,
  validateRowMapping,
} from "../../../src/patent/claim-chart/runtime/mapping-machine.js";
import type { ChartRow, ChartTarget, ClaimElement } from "../../../src/patent/claim-chart/protocol/types.js";

const ELEMENTS: ClaimElement[] = [
  { id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" },
  { id: "1b", claimNo: 1, text: "和滤芯", kind: "limitation" },
  { id: "1c", claimNo: 1, text: "所述滤芯含有活性炭", kind: "limitation" },
];

const D1: ChartTarget = { id: "D1", kind: "prior-art" };
const PRODUCT: ChartTarget = { id: "产品A", kind: "accused-product" };

function row(elementId: string, targetId: string, mapping: ChartRow["mapping"]): ChartRow {
  return { elementId, targetId, quote: "", pinCite: "", mapping, state: mapping, verified: false };
}

test("anticipation/obviousness-combination 仅限 prior-art 目标", () => {
  assert.deepEqual(validateRowMapping(row("1a", "产品A", "anticipation"), PRODUCT, "infringement"), [
    '行 [1a→产品A] 的 mapping "anticipation" 仅适用于 prior-art 目标',
  ]);
  assert.deepEqual(validateRowMapping(row("1a", "D1", "anticipation"), D1, "invalidity"), []);
});

test("doe 仅限侵权模式", () => {
  assert.equal(validateRowMapping(row("1a", "产品A", "doe"), PRODUCT, "invalidity").length, 1);
  assert.deepEqual(validateRowMapping(row("1a", "产品A", "doe"), PRODUCT, "infringement"), []);
});

test("unevaluated 在任意目标与场景合法", () => {
  for (const target of [D1, PRODUCT]) {
    for (const mode of ["invalidity", "infringement", "patentability", "oa-response", "reexamination"] as const) {
      assert.deepEqual(validateRowMapping(row("1a", target.id, "unevaluated"), target, mode), []);
    }
  }
});

test("十值 mapping 全部可构造且行级校验不崩溃", () => {
  const all: ChartRow["mapping"][] = [
    "literal",
    "literal-construction-dependent",
    "doe",
    "anticipation",
    "obviousness-combination",
    "partial",
    "not-found",
    "needs-evidence",
    "construction-dependent",
    "unevaluated",
  ];
  for (const mapping of all) {
    assert.doesNotThrow(() => validateRowMapping(row("1a", "D1", mapping), D1, "invalidity"));
  }
});

test("新颖性单篇全覆盖推导：有缺口时不覆盖", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "literal"), row("1c", "D1", "not-found")];
  const res = deriveNoveltyCoverage(rows, "D1", ELEMENTS);
  assert.equal(res.covered, false);
  assert.deepEqual(res.missing, ["1c"]);
  assert.deepEqual(res.unevaluated, []);
});

test("新颖性单篇全覆盖推导：anticipation 计入覆盖", () => {
  const rows = [
    row("1a", "D1", "anticipation"),
    row("1b", "D1", "literal"),
    row("1c", "D1", "literal-construction-dependent"),
  ];
  const res = deriveNoveltyCoverage(rows, "D1", ELEMENTS);
  assert.equal(res.covered, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.unevaluated, []);
});

test("新颖性覆盖把未评估要素单列，不计入 missing", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "literal")];
  const res = deriveNoveltyCoverage(rows, "D1", ELEMENTS);
  assert.equal(res.covered, false);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.unevaluated, ["1c"]);
});

test("显式 unevaluated 行同样计入 unevaluated 而非 missing", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "literal"), row("1c", "D1", "unevaluated")];
  const res = deriveNoveltyCoverage(rows, "D1", ELEMENTS);
  assert.equal(res.covered, false);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.unevaluated, ["1c"]);
});

test("区别特征 = 主目标上 not-found/needs-evidence 的要素", () => {
  const rows = [
    row("1a", "D1", "literal"),
    row("1b", "D1", "not-found"),
    row("1c", "D1", "needs-evidence"),
    row("1c", "D2", "literal"),
  ];
  const res = deriveDistinguishingFeatures(rows, "D1", ELEMENTS);
  assert.deepEqual(res.features, ["1b", "1c"]);
  assert.deepEqual(res.unevaluatedElements, []);
});

test("未评估要素不当作区别特征，另列 unevaluatedElements", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "not-found")];
  const res = deriveDistinguishingFeatures(rows, "D1", ELEMENTS);
  assert.deepEqual(res.features, ["1b"]);
  assert.deepEqual(res.unevaluatedElements, ["1c"]);
});

test("显式 unevaluated 不进入区别特征", () => {
  const rows = [row("1a", "D1", "literal"), row("1b", "D1", "not-found"), row("1c", "D1", "unevaluated")];
  const res = deriveDistinguishingFeatures(rows, "D1", ELEMENTS);
  assert.deepEqual(res.features, ["1b"]);
  assert.deepEqual(res.unevaluatedElements, ["1c"]);
});
