/**
 * src/patent/figure/multi-figure-consistency.ts — 多图一致性检查测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { checkFigureConsistency } from "../../../src/patent/figure/multi-figure-consistency.js";
import type { FigureAnalysisResult } from "../../../src/patent/figure/types.js";

function makeFig(
  figureNumber: number,
  components: { ref: string; symbol: string; category: "passive" | "ic"; name: string; value?: string }[],
  nets: { name: string; connectedRefs: string[] }[],
): FigureAnalysisResult {
  return {
    imagePath: `fig${figureNumber}.png`,
    figureNumber,
    figureType: "circuit",
    overallDescription: "电路图",
    components: components.map(c => ({
      refNumber: c.ref,
      name: c.name,
      kind: "electrical" as const,
      description: "",
    })),
    connections: [],
    figureDescription: `图${figureNumber}为电路图`,
    confidence: 0.9,
    warnings: [],
    usable: true,
    modelUsed: "test",
    electrical: {
      components: components.map(c => ({ ...c, category: c.category, terminalCount: 2 })),
      nets,
    },
  };
}

test("checkFigureConsistency: 合并多图元件与网络", () => {
  const figs = [
    makeFig(
      1,
      [{ ref: "R1", symbol: "resistor", category: "passive", name: "电阻" }],
      [{ name: "N1", connectedRefs: ["R1.1"] }],
    ),
    makeFig(
      2,
      [{ ref: "C1", symbol: "capacitor", category: "passive", name: "电容" }],
      [{ name: "N1", connectedRefs: ["C1.1"] }],
    ),
  ];
  const report = checkFigureConsistency(figs);
  assert.equal(report.figureCount, 2);
  assert.equal(Object.keys(report.globalComponents).length, 2);
  assert.ok(report.globalNets.N1, "应合并同名网络 N1");
  assert.ok(report.globalNets.N1.connectedRefs.includes("R1.1"));
  assert.ok(report.globalNets.N1.connectedRefs.includes("C1.1"));
  assert.equal(report.consistent, true);
});

test("checkFigureConsistency: 检测跨图标记冲突", () => {
  const figs = [
    makeFig(1, [{ ref: "R1", symbol: "resistor", category: "passive", name: "电阻" }], []),
    makeFig(2, [{ ref: "R1", symbol: "capacitor", category: "passive", name: "电阻" }], []),
  ];
  const report = checkFigureConsistency(figs);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].ref, "R1");
  assert.equal(report.conflicts[0].kind, "symbol");
  assert.equal(report.consistent, false);
  assert.ok(report.warnings.some(w => w.includes("R1")));
});

test("checkFigureConsistency: 检测图号不连续", () => {
  const figs = [
    makeFig(1, [{ ref: "R1", symbol: "resistor", category: "passive", name: "电阻" }], []),
    makeFig(3, [{ ref: "R2", symbol: "resistor", category: "passive", name: "电阻" }], []),
  ];
  const report = checkFigureConsistency(figs);
  assert.deepEqual(report.missingFigureNumbers, [2]);
  assert.equal(report.consistent, false);
});

test("checkFigureConsistency: 检测权利要求中缺失标记", () => {
  const figs = [makeFig(1, [{ ref: "R1", symbol: "resistor", category: "passive", name: "电阻" }], [])];
  const report = checkFigureConsistency(figs, "权利要求1：一种电路，包括电阻R1和电容C2。");
  assert.deepEqual(report.missingRefs, ["C2"]);
  assert.equal(report.consistent, false);
});

test("checkFigureConsistency: 忽略电源单引脚网络", () => {
  const figs = [
    makeFig(
      1,
      [{ ref: "U1", symbol: "ic_chip", category: "ic", name: "芯片" }],
      [{ name: "VCC", connectedRefs: ["U1.8"] }],
    ),
  ];
  const report = checkFigureConsistency(figs);
  assert.deepEqual(report.orphanNets, []);
});

test("checkFigureConsistency: 检测孤立网络", () => {
  const figs = [
    makeFig(
      1,
      [{ ref: "R1", symbol: "resistor", category: "passive", name: "电阻" }],
      [{ name: "FLOAT", connectedRefs: ["R1.1"] }],
    ),
  ];
  const report = checkFigureConsistency(figs);
  assert.deepEqual(report.orphanNets, ["FLOAT"]);
});

test("checkFigureConsistency: 空输入返回空但一致", () => {
  const report = checkFigureConsistency([]);
  assert.equal(report.figureCount, 0);
  assert.equal(report.consistent, true);
  assert.ok(report.summary.includes("附图 0 张"));
});
