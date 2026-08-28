/**
 * src/patent/figuregen — SVG 回读解析与 A4 HTML 版式测试。
 *
 * 回读：解析本模块渲染器产出的 SVG（data-ref 属性 + 图号标注），重建 FigureSpec
 * 供 patent_figure_check 对已交付文件复核。约束：仅保证解析本渲染器的输出。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseFigureSvg } from "../../../src/patent/figuregen/readback.js";
import { renderFiguresHtml } from "../../../src/patent/figuregen/html.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

const SPEC: FigureSpec = {
  figure_no: 2,
  kind: "block",
  nodes: [
    { id: "in", label: "输入模块(10)", ref: 10 },
    { id: "plain", label: "开始", shape: "ellipse" },
    { id: "cpu", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "in", to: "cpu" }],
};

test("回读：图号、data-ref 标记与 label 主干还原", () => {
  const { svg } = renderFigureSvg(SPEC);
  const figure = parseFigureSvg(svg);
  assert.equal(figure.figureNo, 2);
  assert.deepEqual(
    figure.nodes.filter(n => n.ref !== undefined).map(n => [n.id, n.ref, n.label]),
    [
      ["in", 10, "输入模块(10)"],
      ["cpu", 20, "处理模块(20)"],
    ],
  );
  assert.ok(figure.nodes.some(n => n.id === "plain" && n.ref === undefined));
});

test("回读 → 校验闭环：重建的 FigureSpec 通过 V2/V4 细则 21 条核验", () => {
  const { svg } = renderFigureSvg(SPEC);
  const parsed = parseFigureSvg(svg);
  const reconstructed: FigureSpec = {
    figure_no: parsed.figureNo,
    kind: "block",
    nodes: parsed.nodes,
    edges: [],
  };
  const result = checkFigures([reconstructed], "输入模块(10)与处理模块(20)电连接。");
  // 孤立"图2"必然触发 V1（单幅应编为图1）；V2/V4 必须干净
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V2" || f.rule === "V4"),
    [],
  );
  assert.deepEqual(result.refsInFigures, [10, 20]);
});

test("回读：无图号标注的 SVG 抛出明确错误", () => {
  assert.throws(() => parseFigureSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), /图N/u);
});

test("A4 HTML：单文件、@page A4、逐图分页、黑白约束", () => {
  const html = renderFiguresHtml([SPEC], { title: "一种处理装置" });
  assert.ok(html.includes("@page"));
  assert.ok(html.includes("size: A4"));
  assert.ok(html.includes("一种处理装置"));
  assert.ok(html.includes('data-ref="10"'));
  assert.ok(html.includes('data-ref="20"'));
  // 每幅附图一个分页节
  assert.ok((html.match(/class="figure-page"/g) ?? []).length === 1);
  // 黑白不变式同样成立
  const colors = html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  for (const color of colors) {
    assert.ok(color.toUpperCase() === "#000000" || color.toUpperCase() === "#FFFFFF", `发现非黑白颜色 ${color}`);
  }
});
