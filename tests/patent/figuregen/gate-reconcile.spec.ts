/**
 * tests/patent/figuregen/gate-reconcile —— figure-gate 跨层计数去重。
 *
 * 契约：C9↔RC5（越界）与 C11↔RC1（标号退化）同图同现时只计一次；未配对的发现原样计数；
 * `rawFail` 保留原始和供阻断判定（去重只影响报告数字）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { reconcileGateCounts } from "../../../src/patent/figuregen/gate-reconcile.js";

const base = { structuralFails: 0, structuralWarns: 0, rasterFails: 0, rasterWarns: 0 };

test("C9 与 RC5 同图同现：fail 计 1、rawFail 保留 2、合并说明带图号", () => {
  const counts = reconcileGateCounts({
    ...base,
    render: [{ figure_no: 1, rule: "RC5", severity: "fail" }],
    geometry: [{ figure_no: 1, rule: "C9", severity: "fail" }],
  });
  assert.equal(counts.rawFail, 2);
  assert.equal(counts.fail, 1);
  assert.equal(counts.merged.length, 1);
  assert.match(counts.merged[0]!, /图1.*C9.*RC5/u);
});

test("C9 与 RC5 落在不同图：不合并（各自的缺陷都要计数）", () => {
  const counts = reconcileGateCounts({
    ...base,
    render: [{ figure_no: 2, rule: "RC5", severity: "fail" }],
    geometry: [{ figure_no: 1, rule: "C9", severity: "fail" }],
  });
  assert.equal(counts.rawFail, 2);
  assert.equal(counts.fail, 2);
  assert.deepEqual(counts.merged, []);
});

test("C11 与 RC1 同图同现：warn 去掉重复项，fail 保留", () => {
  const counts = reconcileGateCounts({
    ...base,
    render: [{ figure_no: 1, rule: "RC1", severity: "fail" }],
    geometry: [{ figure_no: 1, rule: "C11", severity: "warn" }],
  });
  assert.equal(counts.rawFail, 1);
  assert.equal(counts.fail, 1);
  assert.equal(counts.rawWarn, 1);
  assert.equal(counts.warn, 0);
  assert.match(counts.merged[0]!, /C11.*RC1/u);
});

test("只有 C11（没有 RC1）：warn 原样保留（无引线落位本身仍要报告）", () => {
  const counts = reconcileGateCounts({
    ...base,
    render: [],
    geometry: [{ figure_no: 1, rule: "C11", severity: "warn" }],
  });
  assert.equal(counts.warn, 1);
  assert.deepEqual(counts.merged, []);
});

test("结构/栅格发现不参与跨层合并，原样计入两端", () => {
  const counts = reconcileGateCounts({
    structuralFails: 1,
    structuralWarns: 2,
    rasterFails: 1,
    rasterWarns: 1,
    render: [{ figure_no: 1, rule: "RC5", severity: "fail" }],
    geometry: [{ figure_no: 1, rule: "C9", severity: "fail" }],
  });
  assert.equal(counts.rawFail, 4);
  assert.equal(counts.fail, 3);
  assert.equal(counts.rawWarn, 3);
  assert.equal(counts.warn, 3);
});

test("同图多条 RC1：C11 只抵消一条 warn，不吞掉额外的贯穿缺陷", () => {
  const counts = reconcileGateCounts({
    ...base,
    render: [
      { figure_no: 1, rule: "RC1", severity: "fail" },
      { figure_no: 1, rule: "RC1", severity: "fail" },
    ],
    geometry: [{ figure_no: 1, rule: "C11", severity: "warn" }],
  });
  assert.equal(counts.rawFail, 2);
  assert.equal(counts.fail, 2);
  assert.equal(counts.warn, 0);
});
