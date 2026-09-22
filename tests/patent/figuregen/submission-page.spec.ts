/**
 * src/patent/figuregen/submission-page — 提交落版页测试（W1-2）。
 *
 * 断言三件事：① 版式坐标符合条文（图号在图形正下方、页码在版心上沿、图形居中）；
 * ② 单位解析与放大/缩放上限（画面失真防护）；③ **落版页仍可被 `parseFigureSvg` 回读**——
 * 这是 `figure-gate` 漂移检测能在落版页上继续生效的前提（嵌套 `<g>` 不破坏栈式扫描）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { layoutFigure } from "../../../src/patent/figuregen/layout.js";
import { officeProfile, printableArea } from "../../../src/patent/figuregen/office-profile.js";
import { pxToMm } from "../../../src/patent/figuregen/page-contract.js";
import { parseFigureSvg } from "../../../src/patent/figuregen/readback.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import { buildSubmissionPage, type SubmissionPageOptions } from "../../../src/patent/figuregen/submission-page.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

const SPEC: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "start", label: "开始", shape: "ellipse" },
    { id: "step", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "start", to: "step", label: "是" }],
};

function drawing(spec: FigureSpec = SPEC, figureCount = 1): string {
  return renderFigureSvg(spec, { jurisdiction: "cn", figureCount }).svg;
}

/** 取页面里第 n 个 `<text>` 的 x/y 与内容。 */
function texts(svg: string): { x: string; y: string; value: string }[] {
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/gu)].map(match => ({
    x: match[1],
    y: match[2],
    value: match[3],
  }));
}

/** 取嵌套图形的 x/y/width/height。 */
function nestedBox(svg: string): { x: number; y: number; width: number; height: number } {
  const match = svg.match(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/u);
  assert.ok(match, "落版页应含定位好的嵌套图形");
  return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
}

test("落版：图形居中于版心，图号在图形正下方，页码在版心上沿（cnipa）", () => {
  const profile = officeProfile("cnipa");
  const area = printableArea(profile);
  // 用不带图号的图形（pct/us 单幅形态）：页面层的图号是唯一可见图号，断言不会被图形内部标注干扰
  const page = buildSubmissionPage({
    drawingSvg: renderFigureSvg(SPEC, { jurisdiction: "us" }).svg,
    office: "cnipa",
    caption: "图1",
    sheetIndex: 1,
    sheetTotal: 3,
  });

  const box = nestedBox(page.svg);
  // 居中：左/右留白相等（版心内居中）
  const leftGap = box.x - profile.margins.leftMm;
  const rightGap = profile.margins.leftMm + area.widthMm - (box.x + box.width);
  assert.ok(Math.abs(leftGap - rightGap) < 0.05, `左右留白应相等：${leftGap} vs ${rightGap}`);

  // 图号：居中、在图形下沿之下（"标注在相应附图的正下方"，指南一部一章 4.3）
  const caption = texts(page.svg).find(text => text.value === "图1");
  assert.ok(caption, "落版页应含图号");
  assert.equal(Number(caption.x), profile.paper.widthMm / 2, "图号须左右居中");
  assert.ok(Number(caption.y) > box.y + box.height, "图号须在图形下方");
  assert.ok(Number(caption.y) < page.metrics.sheetBaselineMm!, "图号须在页码之上");

  // 页码：CN 5.6「置于每页下部页边的上沿」⇒ 基线落在 (页高 − 下边距)
  assert.equal(page.metrics.sheetBaselineMm, profile.paper.heightMm - profile.margins.bottomMm);
  const sheet = texts(page.svg).find(text => text.value === "1");
  assert.ok(sheet, "CN 页码为顺序阿拉伯数字");
  assert.equal(Number(sheet.y), page.metrics.sheetBaselineMm);
});

test("落版：页码体例按法域档案（PCT/US 形如 1/3，CN 顺序数字）", () => {
  const pct = buildSubmissionPage({
    drawingSvg: drawing(),
    office: "pct",
    caption: "Fig. 1",
    sheetIndex: 2,
    sheetTotal: 3,
  });
  assert.ok(texts(pct.svg).some(text => text.value === "2/3"));
  const uspto = buildSubmissionPage({
    drawingSvg: drawing(),
    office: "uspto",
    caption: "FIG. 1",
    sheetIndex: 1,
    sheetTotal: 3,
  });
  assert.ok(texts(uspto.svg).some(text => text.value === "1/3"));
  const cnipa = buildSubmissionPage({ drawingSvg: drawing(), office: "cnipa", sheetIndex: 2, sheetTotal: 3 });
  assert.ok(texts(cnipa.svg).some(text => text.value === "2"));
});

test("落版：无图号/无页码时页面只多出定位元素（不凭空画编号）", () => {
  const source = renderFigureSvg(SPEC, { jurisdiction: "cn", figureCount: 1 }).svg;
  const page = buildSubmissionPage({ drawingSvg: source, office: "uspto" });
  assert.equal(page.metrics.captionBaselineMm, undefined);
  assert.equal(page.metrics.sheetBaselineMm, undefined);
  // 页面层不新增任何 `<text>`：可见文本全部来自内嵌图形（图号画在图内标注带上）
  const countTexts = (svg: string): number => (svg.match(/<text\b/gu) ?? []).length;
  assert.equal(countTexts(page.svg), countTexts(source));
});

test("落版：单位解析（mm/pt/px/无单位）与仅 viewBox 回退", () => {
  const cases: { svg: string; widthMm: number }[] = [
    { svg: '<svg width="100mm" height="50mm"></svg>', widthMm: 100 },
    { svg: '<svg width="10cm" height="5cm"></svg>', widthMm: 100 },
    { svg: '<svg width="4in" height="2in"></svg>', widthMm: 101.6 },
    { svg: '<svg width="72pt" height="36pt"></svg>', widthMm: 25.4 },
    { svg: '<svg width="96" height="48"></svg>', widthMm: pxToMm(96) },
    { svg: '<svg viewBox="0 0 96 48"></svg>', widthMm: pxToMm(96) },
  ];
  for (const testCase of cases) {
    const page = buildSubmissionPage({ drawingSvg: testCase.svg, office: "cnipa" });
    assert.ok(
      Math.abs(page.metrics.drawingWidthMm - testCase.widthMm) < 0.01,
      `${testCase.svg} 宽度应为 ${testCase.widthMm}mm，实际 ${page.metrics.drawingWidthMm}`,
    );
  }
  assert.throws(() => buildSubmissionPage({ drawingSvg: "<svg></svg>" }), /无法落版/u);
});

test("落版：小图放大有上限并出告警；大图缩放也出告警", () => {
  const tiny = buildSubmissionPage({ drawingSvg: '<svg width="5mm" height="5mm"></svg>', office: "cnipa" });
  assert.equal(tiny.metrics.pageScale, 4, "默认放大上限 4×");
  assert.ok(
    tiny.warnings.some(warning => warning.includes("上限放大")),
    tiny.warnings.join(" / "),
  );

  const huge = buildSubmissionPage({ drawingSvg: '<svg width="400mm" height="500mm"></svg>', office: "cnipa" });
  assert.ok(huge.metrics.pageScale < 1);
  assert.ok(
    huge.warnings.some(warning => warning.includes("落版缩放")),
    huge.warnings.join(" / "),
  );
});

test("落版：字高估算随落版缩放（供 V7 口径对照）", () => {
  const page = buildSubmissionPage({ drawingSvg: drawing(), office: "cnipa", sourceCharHeightMm: 3.7 });
  assert.ok(Math.abs(page.metrics.charHeightMm - 3.7 * page.metrics.pageScale) < 1e-9);
  assert.ok(Math.abs(page.metrics.reducedCharHeightMm - page.metrics.charHeightMm * (2 / 3)) < 1e-9);
});

test("落版：页面可被 parseFigureSvg 回读（图号与 data-ref 集合不变）", () => {
  const page = buildSubmissionPage({
    drawingSvg: drawing(),
    office: "cnipa",
    caption: "图1",
    sheetIndex: 1,
    sheetTotal: 1,
  });
  const parsed = parseFigureSvg(page.svg);
  assert.equal(parsed.figureNo, 1, "根元素带 data-figure-no，回读不依赖可见图号");
  assert.equal(parsed.numbered, true, "页面上的图号是可见标注");
  assert.deepEqual(
    parsed.nodes.filter(node => node.ref !== undefined).map(node => `${node.id}:${node.ref}`),
    ["step:20"],
  );
});

test("落版：单幅在 pct/us 无图号时页面同样可回读（不靠可见图号取号）", () => {
  const single = renderFigureSvg(SPEC, { jurisdiction: "us" }).svg;
  const page = buildSubmissionPage({ drawingSvg: single, office: "uspto" });
  const parsed = parseFigureSvg(page.svg);
  assert.equal(parsed.figureNo, 1);
  assert.equal(parsed.numbered, false);
});

test("落版：版心不足以容纳图号与页码时 fail-explicit", () => {
  const options: SubmissionPageOptions = {
    drawingSvg: drawing(),
    office: "cnipa",
    caption: "图1",
    captionFontMm: 300,
  };
  assert.throws(() => buildSubmissionPage(options), /版心不足/u);
});

test("落版：与核验器同源——layoutFigure 的图幅就是落版页量到的图幅", () => {
  const layout = layoutFigure(SPEC, { caption: true });
  const page = buildSubmissionPage({ drawingSvg: drawing(), office: "cnipa", caption: "图1" });
  assert.ok(Math.abs(page.metrics.drawingWidthMm - pxToMm(layout.width)) < 0.01);
  assert.ok(Math.abs(page.metrics.drawingHeightMm - pxToMm(layout.height)) < 0.01);
});
