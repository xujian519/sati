/**
 * src/patent/figuregen/render-utils — 共享小工具测试。
 *
 * 这些函数原先在四个渲染器里各写一份（`escapeXml` 逐字相同、`fmt` 精度漂移到 1/2/3 位、
 * 几何谓词两份），收敛后本文件是它们的**唯一断言点**：精度是显式参数、转义不二次展开、
 * 几何谓词的容差方向（相切不算压盖、贴边不算越界）不再由各调用方各自解释。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  boxesOverlap,
  boxWithin,
  escapeXml,
  fmt,
  FMT_DIGITS,
  GEOMETRY_EPS,
} from "../../../src/patent/figuregen/render-utils.js";

test("fmt：默认 1 位小数（与内置渲染器同源）", () => {
  assert.equal(FMT_DIGITS, 1);
  assert.equal(fmt(12.34), "12.3");
  assert.equal(fmt(12.36), "12.4");
  assert.equal(fmt(-0.04), "0"); // Math.round(-0.4) === -0，String 归一为 "0"
});

test("fmt：小数位是显式参数（CAD 3 位 / 落版页 2 位 / 刻度 6 位）", () => {
  assert.equal(fmt(1.23456, 2), "1.23");
  assert.equal(fmt(1.23456, 3), "1.235");
  assert.equal(fmt(1.2345678, 6), "1.234568");
  // 精度不再是"各文件各持一个默认值"：同一输入在不同位数下产出不同（需求本身如此）
  assert.notEqual(fmt(1.23456, 2), fmt(1.23456, 3));
});

test("escapeXml：五个预定义实体全覆盖", () => {
  assert.equal(escapeXml(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
});

test("escapeXml：& 先行，已转义的文本不被二次展开", () => {
  // "&lt;" 是四个普通字符，输出必须是 "&amp;lt;" 而不是 "<"——否则转义函数可被反向利用
  assert.equal(escapeXml("&lt;script&gt;"), "&amp;lt;script&amp;gt;");
});

test("escapeXml：发明名称里的标签注入被中和（交付 HTML/SVG 结构不被名称改变）", () => {
  const injected = `一种装置</title><script>alert(1)</script> & <b>粗</b>`;
  const escaped = escapeXml(injected);
  assert.ok(!escaped.includes("</title>"));
  assert.ok(!escaped.includes("<script>"));
  assert.ok(escaped.includes("&lt;/title&gt;"));
});

test("boxesOverlap：相交为真，分离/相切为假", () => {
  const a = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.equal(boxesOverlap(a, { left: 5, top: 5, right: 15, bottom: 15 }), true);
  assert.equal(boxesOverlap(a, { left: 20, top: 0, right: 30, bottom: 10 }), false);
  // 相切（右边 == 左边）不算压盖：标号贴着放是常规排版，不是缺陷
  assert.equal(boxesOverlap(a, { left: 10, top: 0, right: 20, bottom: 10 }), false);
});

test("boxesOverlap：容差内的浮点误差不改变结论（相切留 EPS 余量）", () => {
  const a = { left: 0, top: 0, right: 10, bottom: 10 };
  const nudged = { left: 10 - GEOMETRY_EPS / 2, top: 0, right: 20, bottom: 10 };
  assert.equal(boxesOverlap(a, nudged), false);
});

test("boxWithin：完全内含与贴边为真，越界为假", () => {
  const outer = { left: 0, top: 0, right: 100, bottom: 100 };
  assert.equal(boxWithin({ left: 10, top: 10, right: 90, bottom: 90 }, outer), true);
  assert.equal(boxWithin({ left: 0, top: 0, right: 100, bottom: 100 }, outer), true); // 贴边不算越界
  assert.equal(boxWithin({ left: -1, top: 0, right: 100, bottom: 100 }, outer), false);
  assert.equal(boxWithin({ left: 0, top: 0, right: 100.5, bottom: 100 }, outer), false);
});
