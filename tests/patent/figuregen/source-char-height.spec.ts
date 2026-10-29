/**
 * src/patent/figuregen — 源图字高映射测试。
 *
 * 生成期与门禁必须调同一个函数：两处各写一份时 graphviz-wasm 这类分支会在一侧漏掉，
 * 同一张图在生成期按 14px、在门禁按 12pt 判，结论互相矛盾。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CAD_REF_FONT_MM, CAD_REF_FONT_STATUTORY_MM } from "../../../src/patent/figuregen/cad/index.js";
import {
  EDGE_FONT_RATIO,
  edgeFontPt,
  edgeFontSizePx,
  figureFontPt,
  figureFontSizePx,
} from "../../../src/patent/figuregen/metrics.js";
import { pxToMm } from "../../../src/patent/figuregen/page-contract.js";
import { sourceCharHeightMm } from "../../../src/patent/figuregen/source-char-height.js";

test("sourceCharHeightMm：按渲染器取图内最小字高，graphviz 与 wasm 同值", () => {
  // 显式传空 env：用例不受宿主是否设了 SATI_FIGURE_FONT_MM 影响（否则本机配了部署字号即红）。
  assert.equal(sourceCharHeightMm("cad", undefined, {}), CAD_REF_FONT_MM);
  assert.equal(sourceCharHeightMm("cad", "cn", {}), CAD_REF_FONT_MM);
  // PCT Rule 11.13(h) / 37 CFR 1.84(p)(3) 的 3.2mm 下限：CAD 标号按法域取 3.5mm
  assert.equal(sourceCharHeightMm("cad", "us", {}), CAD_REF_FONT_STATUTORY_MM);
  assert.equal(sourceCharHeightMm("cad", "pct", {}), CAD_REF_FONT_STATUTORY_MM);
  assert.equal(sourceCharHeightMm("builtin", undefined, {}), pxToMm(14));
  // graphviz 边标签是 12pt（节点 14pt）：判据取更小的那个才有合规意义
  const graphviz = sourceCharHeightMm("graphviz", undefined, {});
  assert.ok(Math.abs(graphviz - (12 / 72) * 25.4) < 1e-9, `12pt 应为 4.23mm：${graphviz}`);
  assert.equal(sourceCharHeightMm("graphviz-wasm", undefined, {}), graphviz);
  // 未知渲染器回落到内置字号（sidecar 的 enum 之外的字符串不应让函数返回 NaN/undefined）
  assert.equal(sourceCharHeightMm("something-else", undefined, {}), pxToMm(14));
});

test("SATI_FIGURE_FONT_MM：部署级主字号覆盖各通路的字高口径", () => {
  const env = { SATI_FIGURE_FONT_MM: "3.5" };
  // 内置与 Graphviz 的边标签是主字号的 12/14：本函数回答"图内最小字"，故按同一比例折算。
  const edge = 3.5 * EDGE_FONT_RATIO;
  assert.equal(sourceCharHeightMm("builtin", undefined, env), edge);
  assert.equal(sourceCharHeightMm("graphviz", "cn", env), edge);
  assert.equal(sourceCharHeightMm("graphviz-wasm", "cn", env), edge);
  // CAD 没有主/次字号之分：标号本身就是最小字，直取 env（法域不再影响，env 是部署级决定）。
  assert.equal(sourceCharHeightMm("cad", "cn", env), 3.5);
  assert.equal(sourceCharHeightMm("cad", "us", env), 3.5);
});

test("SATI_FIGURE_FONT_MM：未设、空串与非法值都不改变既有口径", () => {
  for (const env of [{}, { SATI_FIGURE_FONT_MM: "  " }, { SATI_FIGURE_FONT_MM: "abc" }, { SATI_FIGURE_FONT_MM: "0" }]) {
    assert.equal(sourceCharHeightMm("builtin", undefined, env), pxToMm(14), JSON.stringify(env));
    assert.equal(sourceCharHeightMm("cad", "us", env), CAD_REF_FONT_STATUTORY_MM, JSON.stringify(env));
  }
});

test("字号链：主字号按单位换算，边标签按 12/14 折算（未设 env 时与既有常量一致）", () => {
  // 未设 env：px / pt 都回落到既有 14，边标签 12——既有快照不变。
  assert.equal(figureFontSizePx({}), 14);
  assert.equal(figureFontPt({}), 14);
  assert.equal(edgeFontSizePx(14), 12);
  assert.equal(edgeFontPt(14), 12);
  // 设 3.5mm：13.2px（3.5 ÷ 25.4/96）、9.9pt（3.5 × 72/25.4），边标签各自折算后再取一位小数。
  assert.equal(figureFontSizePx({ SATI_FIGURE_FONT_MM: "3.5" }), 13.2);
  assert.equal(figureFontPt({ SATI_FIGURE_FONT_MM: "3.5" }), 9.9);
  assert.equal(edgeFontSizePx(figureFontSizePx({ SATI_FIGURE_FONT_MM: "3.5" })), 11.3);
  assert.equal(edgeFontPt(figureFontPt({ SATI_FIGURE_FONT_MM: "3.5" })), 8.5);
});
