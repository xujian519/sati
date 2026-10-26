/**
 * src/patent/figuregen — 源图字高映射测试。
 *
 * 生成期与门禁必须调同一个函数：两处各写一份时 graphviz-wasm 这类分支会在一侧漏掉，
 * 同一张图在生成期按 14px、在门禁按 12pt 判，结论互相矛盾。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CAD_REF_FONT_MM, CAD_REF_FONT_STATUTORY_MM } from "../../../src/patent/figuregen/cad/index.js";
import { pxToMm } from "../../../src/patent/figuregen/page-contract.js";
import { sourceCharHeightMm } from "../../../src/patent/figuregen/source-char-height.js";

test("sourceCharHeightMm：按渲染器取图内最小字高，graphviz 与 wasm 同值", () => {
  assert.equal(sourceCharHeightMm("cad"), CAD_REF_FONT_MM);
  assert.equal(sourceCharHeightMm("cad", "cn"), CAD_REF_FONT_MM);
  // PCT Rule 11.13(h) / 37 CFR 1.84(p)(3) 的 3.2mm 下限：CAD 标号按法域取 3.5mm
  assert.equal(sourceCharHeightMm("cad", "us"), CAD_REF_FONT_STATUTORY_MM);
  assert.equal(sourceCharHeightMm("cad", "pct"), CAD_REF_FONT_STATUTORY_MM);
  assert.equal(sourceCharHeightMm("builtin"), pxToMm(14));
  // graphviz 边标签是 12pt（节点 14pt）：判据取更小的那个才有合规意义
  const graphviz = sourceCharHeightMm("graphviz");
  assert.ok(Math.abs(graphviz - (12 / 72) * 25.4) < 1e-9, `12pt 应为 4.23mm：${graphviz}`);
  assert.equal(sourceCharHeightMm("graphviz-wasm"), graphviz);
  // 未知渲染器回落到内置字号（sidecar 的 enum 之外的字符串不应让函数返回 NaN/undefined）
  assert.equal(sourceCharHeightMm("something-else"), pxToMm(14));
});
