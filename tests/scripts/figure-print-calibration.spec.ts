/**
 * 打印校准页 —— 结构与"取自代码常量"的断言。
 *
 * 该页是**测量仪器**（把推导阈值变成可实测）：所以测试只锁定两件事——版面确定性、
 * 以及页面上的档位确实来自当前常量（常量改了校准页必须跟着变，否则会校准到过期数字上）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  FONT_STEPS_MM,
  GAP_STEPS_MM,
  GRAY_STEPS,
  LINE_STEPS_MM,
  buildCalibrationSvg,
} from "../../scripts/figure-print-calibration.js";
import { A4_HEIGHT_MM, A4_WIDTH_MM, MIN_PRINTED_FONT_MM } from "../../src/patent/figuregen/page-contract.js";
import {
  CAD_HATCH_LINE_WIDTH_MM,
  CAD_HATCH_SPACING_MM,
  CAD_LINE_WIDTH_MM,
} from "../../src/patent/figuregen/cad/index.js";
import { PIXEL_MAX_DPI, PIXEL_MID_GRAY_RANGE, PIXEL_MIN_DPI } from "../../src/patent/figuregen/pixel-gate.js";

const SVG = buildCalibrationSvg();

test("校准页：A4 版面且全部元素落在页面内（不溢出纸面）", () => {
  assert.match(SVG, new RegExp(`width="${A4_WIDTH_MM}mm" height="${A4_HEIGHT_MM}mm"`, "u"));
  const coordinates = [...SVG.matchAll(/\b(x|y|x1|y1|x2|y2)="([\d.]+)"/gu)].map(match => ({
    name: match[1]!,
    value: Number(match[2]),
  }));
  assert.ok(coordinates.length > 40, "版面元素数量异常");
  for (const { name, value } of coordinates) {
    const limit = name === "x" || name === "x1" || name === "x2" ? A4_WIDTH_MM : A4_HEIGHT_MM;
    assert.ok(value >= 0 && value <= limit, `${name}=${value} 超出页面（上限 ${limit}mm）`);
  }
});

test("校准页：档位取自当前常量（字体/线宽/剖面线/灰阶/DPI）", () => {
  assert.match(SVG, new RegExp(`当前阈值 ${MIN_PRINTED_FONT_MM}mm`, "u"));
  assert.match(SVG, new RegExp(`轮廓当前 ${CAD_LINE_WIDTH_MM}mm、剖面线 ${CAD_HATCH_LINE_WIDTH_MM}mm`, "u"));
  assert.match(SVG, new RegExp(`剖面线样块（${CAD_HATCH_LINE_WIDTH_MM}mm / ${CAD_HATCH_SPACING_MM}mm 间距）`, "u"));
  assert.match(SVG, new RegExp(`中间灰区间 ${PIXEL_MID_GRAY_RANGE[0]}–${PIXEL_MID_GRAY_RANGE[1]}`, "u"));
  assert.match(SVG, new RegExp(`DPI）：${PIXEL_MIN_DPI}–${PIXEL_MAX_DPI}`, "u"));

  // 字高两行：原尺寸与 2/3 缩小都必须出现（指南一部一章 4.3 的三分之二判据）
  for (const heightMm of FONT_STEPS_MM) {
    for (const sizeMm of [heightMm, heightMm * (2 / 3)]) {
      const rounded = String(Math.round(sizeMm * 1000) / 1000);
      assert.ok(SVG.includes(`font-size="${rounded}"`), `缺少字高档 font-size=${rounded}mm`);
    }
  }
  for (const widthMm of LINE_STEPS_MM) {
    assert.ok(SVG.includes(`stroke-width="${widthMm}"`), `缺少线宽档 ${widthMm}mm`);
  }
  for (const gapMm of GAP_STEPS_MM) {
    assert.ok(SVG.includes(`间距 ${gapMm}mm`), `缺少最小间距档 ${gapMm}mm`);
  }
  for (const gray of GRAY_STEPS) {
    assert.ok(SVG.includes(`fill="rgb(${gray},${gray},${gray})"`), `缺少灰阶块 ${gray}`);
  }
});

test("校准页：确定性（同输入两次同输出；无时钟/随机）", () => {
  assert.equal(buildCalibrationSvg(), SVG);
  assert.doesNotMatch(SVG, /\d{4}-\d{2}-\d{2}T/u, "不得写入时刻");
});
