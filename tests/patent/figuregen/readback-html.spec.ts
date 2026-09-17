/**
 * src/patent/figuregen — SVG 回读解析与 A4 HTML 版式测试。
 *
 * 回读：解析本模块渲染器产出的 SVG（data-ref 属性 + 图号标注），重建 FigureSpec
 * 供 patent_figure_check 对已交付文件复核。约束：仅保证解析本渲染器的输出。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseFigureSvg } from "../../../src/patent/figuregen/readback.js";
import { renderFiguresHtml, svgRootSizeMm } from "../../../src/patent/figuregen/html.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import {
  PAGE_MARGIN_BOTTOM_MM,
  PAGE_MARGIN_LEFT_MM,
  PAGE_MARGIN_RIGHT_MM,
  PAGE_MARGIN_TOP_MM,
  PRINTABLE_HEIGHT_MM,
  PRINTABLE_WIDTH_MM,
  uniformFigureZoom,
} from "../../../src/patent/figuregen/page-contract.js";
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

test("A4 HTML：@page 边距与 max-height/break-inside 与 page-contract 常量同源", () => {
  const html = renderFiguresHtml([SPEC], { title: "一种处理装置" });
  assert.ok(
    html.includes(
      `size: A4; margin: ${PAGE_MARGIN_TOP_MM}mm ${PAGE_MARGIN_RIGHT_MM}mm ${PAGE_MARGIN_BOTTOM_MM}mm ${PAGE_MARGIN_LEFT_MM}mm;`,
    ),
    "页边距须与 page-contract 常量一致（V7 判据与版式同源）",
  );
  assert.ok(html.includes(`max-height: ${PRINTABLE_HEIGHT_MM}mm`), "须限制纵向不超出可印高");
  assert.ok(html.includes("break-inside: avoid"), "图与图号不得跨页切断");
  assert.ok(PRINTABLE_WIDTH_MM === 170 && PRINTABLE_HEIGHT_MM === 257, "A4 可印区应为 170×257mm");
});

test("A4 HTML：图幅按纸面毫米定宽（不用 px 定宽，避免 96dpi 打印溢出）", () => {
  const size = svgRootSizeMm(renderFigureSvg(SPEC).svg);
  assert.ok(size, "内置渲染器输出应可解析画幅");
  const html = renderFiguresHtml([SPEC]);
  assert.ok(
    html.includes(`style="width: ${size!.widthMm.toFixed(1)}mm"`),
    `应写入纸面宽度 ${size!.widthMm.toFixed(1)}mm`,
  );
});

test("A4 HTML：无法解析画幅的 SVG 走 CSS 兜底（不猜测尺寸）", () => {
  const html = renderFiguresHtml([SPEC], {
    renderedSvgs: new Map([[SPEC.figure_no, '<svg xmlns="http://www.w3.org/2000/svg"></svg>']]),
  });
  assert.ok(html.includes("figure-box-auto"), "无画幅声明时用兜底类");
  assert.ok(html.includes("max-width: 100%"));
});

test("A4 HTML：同文档统一缩放系数（含大图时小图同比例缩小）", () => {
  const big: FigureSpec = {
    figure_no: 1,
    kind: "flowchart",
    direction: "TB",
    nodes: Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, label: `步骤${i + 1}` })),
    edges: Array.from({ length: 19 }, (_, i) => ({ from: `b${i}`, to: `b${i + 1}` })),
  };
  const smallSize = svgRootSizeMm(renderFigureSvg(SPEC).svg)!;
  const bigSize = svgRootSizeMm(renderFigureSvg(big).svg)!;
  const zoom = uniformFigureZoom([smallSize, bigSize]);
  assert.ok(zoom < 1, "含超页大图时统一缩放应小于 1");
  const html = renderFiguresHtml([SPEC, big]);
  assert.ok(html.includes(`width: ${(smallSize.widthMm * zoom).toFixed(1)}mm`), "小图按统一系数缩放");
  assert.ok(html.includes(`width: ${(bigSize.widthMm * zoom).toFixed(1)}mm`), "大图按统一系数缩放");
});
