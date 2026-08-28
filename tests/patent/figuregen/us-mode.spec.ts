/**
 * src/patent/figuregen — USPTO 出海模式（jurisdiction: "us"）测试。
 *
 * 图号标注 "FIG. N"（USPTO 惯例）；V8 摘要附图 / V9 实用新型附图为 CNIPA 特有
 * 规则，US 模式下跳过；附图说明草稿输出英文 BRIEF DESCRIPTION OF DRAWINGS 模板。
 * 规则依据见 references/uspto-drawing-rules.md。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildFigureBriefDraft } from "../../../src/patent/figuregen/brief.js";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

function flowchart(figureNo: number, ref?: number): FigureSpec {
  return {
    figure_no: figureNo,
    kind: "flowchart",
    nodes: [
      { id: `f${figureNo}-a`, label: "Start", shape: "ellipse" },
      ...(ref === undefined ? [] : [{ id: `f${figureNo}-b`, label: `Process module(${ref})`, ref }]),
    ],
    edges: [],
  };
}

test("渲染：US 辖区图号标注为 FIG. N；CN 保持 图N", () => {
  const us = renderFigureSvg(flowchart(3), { jurisdiction: "us" });
  assert.match(us.svg, /<text[^>]*>FIG\. 3<\/text>/);
  assert.ok(!us.svg.includes(">图3<"));

  const cn = renderFigureSvg(flowchart(3));
  assert.match(cn.svg, /<text[^>]*>图3<\/text>/);
});

test("校验：US 模式跳过 V8 摘要附图与 V9 实用新型规则", () => {
  const figures = [flowchart(1, 10), flowchart(2, 20)];
  // CN：多图未指定摘要附图 → V8 warn
  const cn = checkFigures(figures, "模块(10)、模块(20)。", { jurisdiction: "cn" });
  assert.ok(cn.findings.some(f => f.rule === "V8"));

  // US：不触发 V8；V9 无从触发
  const us = checkFigures(figures, "module (10), module (20).", { jurisdiction: "us" });
  assert.deepEqual(
    us.findings.filter(f => f.rule === "V8" || f.rule === "V9"),
    [],
  );

  // US：空附图集不触发 V9
  const usEmpty = checkFigures([], "", { jurisdiction: "us", skipTextRules: true });
  assert.deepEqual(
    usEmpty.findings.filter(f => f.rule === "V9"),
    [],
  );
});

test("校验：US 模式 V1/V2/V4 照常，违规信息引用 37 CFR 1.84", () => {
  const result = checkFigures([flowchart(1, 20)], "irrelevant text.", { jurisdiction: "us" });
  assert.ok(result.findings.some(f => f.rule === "V2" && f.severity === "fail"));
  const v1Gap = checkFigures([flowchart(2)], "", { jurisdiction: "us", skipTextRules: true });
  const v1 = v1Gap.findings.find(f => f.rule === "V1");
  assert.ok(v1?.message.includes("37 CFR 1.84"));
});

test("附图说明：US 模式输出英文 BRIEF DESCRIPTION OF DRAWINGS", () => {
  const us = buildFigureBriefDraft([flowchart(1), { ...flowchart(2), kind: "block" }], {
    jurisdiction: "us",
    inventionName: "A data processing apparatus",
  });
  assert.ok(us.includes("BRIEF DESCRIPTION OF THE DRAWINGS"));
  assert.ok(us.includes("FIG. 1 is a flowchart of a method"));
  assert.ok(us.includes("FIG. 2 is a block diagram of a system"));
  assert.ok(us.includes("according to an embodiment"));

  const usNamed = buildFigureBriefDraft([flowchart(1)], {
    jurisdiction: "us",
    inventionName: "A data processing apparatus",
  });
  assert.ok(usNamed.includes('of the "A data processing apparatus"'));

  // Reference numerals 段：US 模式按升序列出
  const markers = buildFigureBriefDraft([{ ...flowchart(1, 10) }, { ...flowchart(2, 20), kind: "block" }], {
    jurisdiction: "us",
  });
  assert.ok(markers.includes("10 — Process module"));
  assert.ok(markers.includes("20 — Process module"));
});
