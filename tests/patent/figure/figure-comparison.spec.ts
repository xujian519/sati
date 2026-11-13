/**
 * src/patent/figure/figure-comparison.ts — 生成侧声明 vs 识图结果比对测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compareFigureAnalysis } from "../../../src/patent/figure/figure-comparison.js";
import type { FigureAnalysisResult, FigureComponentKind } from "../../../src/patent/figure/types.js";

/** 测试用组件声明。 */
type ComponentSpec = {
  /** 附图标记号。 */
  ref: string;
  /** 组件名称（可为空串，模拟「没识别出名字」）。 */
  name: string;
  /** 组件类型（缺省 mechanical）。 */
  kind?: FigureComponentKind;
};

/** 构造一份附图分析结果（只填与比对相关的字段）。 */
function makeResult(imagePath: string, components: readonly ComponentSpec[]): FigureAnalysisResult {
  return {
    imagePath,
    figureNumber: 1,
    figureType: "structure",
    overallDescription: "",
    components: components.map(component => ({
      refNumber: component.ref,
      name: component.name,
      kind: component.kind ?? "mechanical",
      description: "",
    })),
    connections: [],
    figureDescription: "",
    confidence: 0.9,
    warnings: [],
    usable: true,
    modelUsed: "test",
  };
}

test("compareFigureAnalysis: 两侧完全一致时零发现", () => {
  const expected = makeResult("out/fig1.png", [
    { ref: "1", name: "壳体" },
    { ref: "2", name: "盖板" },
  ]);
  // 识图侧的 imagePath 可以是另一张图（生成产物 vs 被分析的图），不因此报发现。
  const actual = makeResult("scan/fig1.png", [
    { ref: "1", name: "壳体" },
    { ref: "2", name: "盖板" },
  ]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 0);
  assert.equal(report.consistent, true);
  assert.equal(report.expectedCount, 2);
  assert.equal(report.actualCount, 2);
  assert.ok(report.summary.includes("图文比对通过"), report.summary);
});

test("compareFigureAnalysis: 声明侧有而识图侧无 ⇒ missing-component", () => {
  const expected = makeResult("out/fig1.png", [
    { ref: "1", name: "壳体" },
    { ref: "2", name: "盖板" },
  ]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "壳体" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.kind, "missing-component");
  assert.equal(finding.ref, "2");
  assert.ok(finding.message.includes("盖板"), finding.message);
  assert.deepEqual(finding.evidence, ["声明标记：2", "声明名称：盖板"]);
  assert.equal(report.consistent, false);
  assert.equal(report.expectedCount, 2);
  assert.equal(report.actualCount, 1);
});

test("compareFigureAnalysis: 识图侧多出未声明标记 ⇒ extra-component", () => {
  const expected = makeResult("out/fig1.png", [{ ref: "1", name: "壳体" }]);
  const actual = makeResult("scan/fig1.png", [
    { ref: "1", name: "壳体" },
    { ref: "2", name: "盖板" },
  ]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.kind, "extra-component");
  assert.equal(finding.ref, "2");
  assert.ok(finding.message.includes("盖板"), finding.message);
  assert.deepEqual(finding.evidence, ["识图标记：2", "识图名称：盖板"]);
  assert.equal(report.consistent, false);
});

test("compareFigureAnalysis: 同一标记名称不同 ⇒ name-mismatch", () => {
  const expected = makeResult("out/fig1.png", [{ ref: "1", name: "壳体" }]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "外壳" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.kind, "name-mismatch");
  assert.equal(finding.ref, "1");
  assert.ok(finding.message.includes("壳体"), finding.message);
  assert.ok(finding.message.includes("外壳"), finding.message);
  assert.deepEqual(finding.evidence, ["声明名称：壳体", "识图名称：外壳"]);
  assert.equal(report.consistent, false);
});

test("compareFigureAnalysis: 同一标记组件类型不同 ⇒ type-mismatch", () => {
  const expected = makeResult("out/fig1.png", [{ ref: "1", name: "壳体", kind: "mechanical" }]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "壳体", kind: "electrical" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.kind, "type-mismatch");
  assert.equal(finding.ref, "1");
  assert.ok(finding.message.includes("mechanical"), finding.message);
  assert.ok(finding.message.includes("electrical"), finding.message);
  assert.deepEqual(finding.evidence, ["声明类型：mechanical", "识图类型：electrical"]);
  assert.equal(report.consistent, false);
});

test("compareFigureAnalysis: 同号异名与异类型同时成立时两条发现都报", () => {
  const expected = makeResult("out/fig1.png", [{ ref: "1", name: "壳体", kind: "mechanical" }]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "外壳", kind: "controller" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.deepEqual(
    report.findings.map(finding => finding.kind),
    ["name-mismatch", "type-mismatch"],
  );
  assert.equal(report.consistent, false);
});

test("compareFigureAnalysis: 非数字标记不参与比对", () => {
  const expected = makeResult("out/fig1.png", [
    { ref: "U1", name: "壳体" },
    { ref: "S101", name: "步骤一" },
    { ref: "0", name: "零号标记" },
    { ref: "1000", name: "超域标记" },
  ]);
  const actual = makeResult("scan/fig1.png", [
    { ref: "U2", name: "另一壳体" },
    { ref: "S102", name: "步骤二" },
  ]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 0);
  assert.equal(report.expectedCount, 0);
  assert.equal(report.actualCount, 0);
  assert.equal(report.consistent, true);
});

test("compareFigureAnalysis: 非数字标记不掩盖数字标记的发现", () => {
  const expected = makeResult("out/fig1.png", [
    { ref: "1", name: "壳体" },
    { ref: "U1", name: "壳体" },
  ]);
  const actual = makeResult("scan/fig1.png", [{ ref: "U1", name: "壳体" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, "missing-component");
  assert.equal(report.findings[0].ref, "1");
  assert.equal(report.expectedCount, 1);
  assert.equal(report.actualCount, 0);
});

test("compareFigureAnalysis: 空名称不判名称冲突", () => {
  const expected = makeResult("out/fig1.png", [{ ref: "1", name: "壳体" }]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "   " }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 0);
  assert.equal(report.consistent, true);
});

test("compareFigureAnalysis: 两侧名称都为空同样不判名称冲突", () => {
  const expected = makeResult("out/fig1.png", [{ ref: "1", name: "" }]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 0);
  assert.equal(report.consistent, true);
});

test("compareFigureAnalysis: 名称去首尾空白后相同不报冲突", () => {
  const expected = makeResult("out/fig1.png", [{ ref: "1", name: " 壳体 " }]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "壳体" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.findings.length, 0);
  assert.equal(report.consistent, true);
});

test("compareFigureAnalysis: 同一标记重复出现按去重后的标记数计", () => {
  const expected = makeResult("out/fig1.png", [
    { ref: "1", name: "壳体" },
    { ref: "1", name: "壳体" },
  ]);
  const actual = makeResult("scan/fig1.png", [{ ref: "1", name: "壳体" }]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.expectedCount, 1);
  assert.equal(report.actualCount, 1);
  assert.equal(report.findings.length, 0);
  assert.equal(report.consistent, true);
});

test("compareFigureAnalysis: summary 报出各类发现数量", () => {
  const expected = makeResult("out/fig1.png", [
    { ref: "1", name: "壳体" },
    { ref: "2", name: "盖板" },
    { ref: "3", name: "卡扣", kind: "mechanical" },
  ]);
  const actual = makeResult("scan/fig1.png", [
    { ref: "1", name: "外壳" },
    { ref: "3", name: "卡扣", kind: "software" },
    { ref: "4", name: "弹簧" },
  ]);
  const report = compareFigureAnalysis(expected, actual);
  assert.equal(report.consistent, false);
  assert.equal(report.expectedCount, 3);
  assert.equal(report.actualCount, 3);
  assert.ok(report.summary.includes("声明 3 个标记，识图 3 个。"), report.summary);
  assert.ok(report.summary.includes("缺标记 1 个。"), report.summary);
  assert.ok(report.summary.includes("多标记 1 个。"), report.summary);
  assert.ok(report.summary.includes("名称不符 1 个。"), report.summary);
  assert.ok(report.summary.includes("类型不符 1 个。"), report.summary);
});
