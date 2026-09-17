/**
 * src/patent/figure — 分析轨 ↔ 核验轨桥接测试（P1-4）。
 *
 * 三处此前空转的能力：
 * - `extractClaimRefs` 只认电学符号前缀（机械案 `壳体(10)与盖板(20)` 返回 []）；
 * - `checkFigureConsistency` 只聚合电学 components，纯数字标记（`components[].refNumber`）
 *   完全不参与跨图对齐；
 * - `checkFigureConsistency` 在 `src/` 内无生产调用方。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { analysisToFigureSpec, figureSpecsToAnalysis } from "../../src/patent/figure/bridge.js";
import { checkFigureConsistency } from "../../src/patent/figure/multi-figure-consistency.js";
import { extractClaimRefs, extractClaimRefsDetailed } from "../../src/patent/figure/validator.js";
import { checkFigures } from "../../src/patent/figuregen/check.js";
import type { FigureAnalysisResult } from "../../src/patent/figure/types.js";
import type { FigureSpec } from "../../src/patent/figuregen/types.js";

const MECHANICAL_TEXT = "壳体(10)与盖板(20)通过螺栓(30)连接，所述壳体(10)内设有电路板(40)。";

test("词法：机械案说明书文本提取数字型标记；电学档行为不变", () => {
  const detailed = extractClaimRefsDetailed(MECHANICAL_TEXT);
  assert.deepEqual(detailed.numerals, [10, 20, 30, 40]);
  assert.deepEqual(detailed.symbols, [], "数字型标记不进电学档（避免污染电学图文的元件对齐）");

  // 电学档保持原行为（仅符号库已知前缀）
  assert.deepEqual(extractClaimRefs("包括电阻R1与电容C2，共20个"), ["R1", "C2"]);
});

test("词法：编号前缀不误判（式(1)/步骤(2)/图(3)/实施例1）与数量词不误判", () => {
  const detailed = extractClaimRefsDetailed("式(1)给出的计算式，步骤(2)与图(3)所示，实施例1中温度20℃至90℃，共20组。");
  assert.deepEqual(detailed.numerals, [], "编号前缀与数量词/数值范围不得判为附图标记");
});

test("多图一致性：同一数字标记跨图名称不一致 → 冲突（机械案非空转）", () => {
  const figures: FigureAnalysisResult[] = [
    analysisResult(1, [{ refNumber: "10", name: "壳体" }]),
    analysisResult(2, [
      { refNumber: "10", name: "盖板" },
      { refNumber: "20", name: "螺栓" },
    ]),
  ];
  const report = checkFigureConsistency(figures, "壳体(10)与盖板(20)。");
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].ref, "10");
  assert.match(report.conflicts[0].message, /壳体 \/ 盖板/u);
  assert.equal(report.consistent, false);
  assert.deepEqual(Object.keys(report.numericComponents).sort(), ["10", "20"]);
});

test("多图一致性：文字引用未在附图中识别 → missingRefs（电学档与数字档分列）", () => {
  const figures: FigureAnalysisResult[] = [analysisResult(1, [{ refNumber: "10", name: "壳体" }])];
  const report = checkFigureConsistency(figures, "壳体(10)与风扇(30)连接。");
  assert.deepEqual(report.missingRefs, ["30"]);
  assert.ok(report.warnings.some(w => w.includes("30")));
});

test("多图一致性：图中无数字标记时不启用数字档（电学案不产生假警告）", () => {
  const figures: FigureAnalysisResult[] = [
    analysisResult(1, [{ refNumber: "U1", name: "控制器" }]),
    analysisResult(2, [{ refNumber: "U1", name: "控制器" }]),
  ];
  const report = checkFigureConsistency(figures, "共 3 组测试，温度 20℃。");
  assert.deepEqual(report.missingRefs, [], "数字档未启用时不得把普通数字判为未识别标记");
});

test("桥接：FigureSpec → 分析骨架保留标记与名称（供多图一致性消费）", () => {
  const specs: FigureSpec[] = [
    {
      figure_no: 1,
      kind: "block",
      nodes: [
        { id: "a", label: "壳体(10)", ref: 10 },
        { id: "b", label: "盖板(20)", ref: 20 },
      ],
      edges: [{ from: "a", to: "b" }],
    },
  ];
  const analysis = figureSpecsToAnalysis(specs);
  assert.equal(analysis.length, 1);
  assert.equal(analysis[0].figureNumber, 1);
  assert.deepEqual(
    analysis[0].components.map(c => [c.refNumber, c.name]),
    [
      ["10", "壳体"],
      ["20", "盖板"],
    ],
  );
  // 骨架来自确定性契约：不算"模型识别置信度"
  assert.equal(analysis[0].usable, true);
});

test("桥接：分析骨架 → FigureSpec（无几何），文字面核验可复用 V2/V3/V4", () => {
  const result = analysisResult(1, [
    { refNumber: "10", name: "壳体" },
    { refNumber: "20", name: "盖板" },
  ]);
  const skeleton = analysisToFigureSpec(result);
  assert.ok(skeleton);
  assert.equal(skeleton!.figure_no, 1);
  assert.deepEqual(skeleton!.edges, []);
  assert.deepEqual(
    skeleton!.nodes.map(n => [n.id, n.ref, n.label]),
    [
      ["c-10", 10, "壳体"],
      ["c-20", 20, "盖板"],
    ],
  );

  const check = checkFigures([skeleton!], "壳体(10)与盖板(20)连接。", { skipLayoutRules: true });
  assert.deepEqual(
    check.findings.filter(f => f.rule === "V2" || f.rule === "V4"),
    [],
  );
  assert.deepEqual(
    check.findings.filter(f => f.rule === "V7"),
    [],
    "skipLayoutRules 下不判画幅",
  );

  const missing = checkFigures([skeleton!], "壳体未在文字中提及。", { skipLayoutRules: true });
  assert.ok(missing.findings.some(f => f.rule === "V2" && f.severity === "fail"));
});

test("桥接：组件为空的分析结果不产出骨架（无标记可核）", () => {
  assert.equal(analysisToFigureSpec(analysisResult(1, [])), undefined);
});

/** 分析结果构造器（仅填桥接与一致性用到的字段）。 */
function analysisResult(figureNumber: number, components: { refNumber: string; name: string }[]): FigureAnalysisResult {
  return {
    imagePath: `fig${figureNumber}.png`,
    figureNumber,
    figureType: "structure",
    overallDescription: "",
    components: components.map(c => ({ ...c, kind: "unknown", description: "" })),
    connections: [],
    figureDescription: "",
    confidence: 0.9,
    warnings: [],
    usable: true,
    modelUsed: "test",
  };
}
