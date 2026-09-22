/**
 * tests/scripts/figure-benchmark/gen-compliance.spec.ts — 生成侧合规基准的回归护栏。
 *
 * 两道防线：
 * ① 基线比对：数值漂移即红，逼出"这次改动是有意的"，并指出漂在哪一项；
 * ② 语义锚点：防止"重新刷基线"把真回归洗白——超框判定、打印字高、名称归一化、
 *    括号按面判定、LR 画幅必须维持在当前语义（这些断言不随基线更新而放宽）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  baselinePath,
  collectMetricDrift,
  computeBenchmarkMetrics,
  parseBaseline,
  type GenBenchmarkMetrics,
  type GenCaseMetrics,
} from "../../../scripts/figure-benchmark/gen-compliance.js";
import { GENERATION_BENCHMARK_CASES } from "../../../scripts/figure-benchmark/gen-cases.js";

const BASELINE = baselinePath(process.cwd());

function readBaselineMetrics(): GenBenchmarkMetrics {
  return parseBaseline(readFileSync(BASELINE, "utf8"));
}

function metricsFor(id: string): GenCaseMetrics {
  const metrics = computeBenchmarkMetrics();
  const found = metrics.cases.find(item => item.id === id);
  assert.ok(found, `基准用例缺少 ${id}`);
  return found;
}

function pageFitFindings(item: GenCaseMetrics): number {
  return item.rule_hits.V7?.fail ?? 0;
}

test("基线一致：生成侧合规指标与入库基线逐项相同", () => {
  const drift = collectMetricDrift(readBaselineMetrics(), computeBenchmarkMetrics());
  assert.deepEqual(
    drift,
    [],
    `生成侧合规指标漂移（预期 → 实际）：\n${drift.map(line => `  - ${line}`).join("\n")}\n` +
      "确认变更符合预期后运行 `pnpm tsx scripts/figure-benchmark/gen-compliance.ts --update`，并在 PR 中说明理由。",
  );
});

test("基线覆盖全部用例（新增用例必须同批刷新基线）", () => {
  const baselineIds = readBaselineMetrics().cases.map(item => item.id);
  assert.deepEqual(
    baselineIds,
    GENERATION_BENCHMARK_CASES.map(item => item.id),
  );
});

test("介质锚定：12 / 16 步流程图的画幅超出 A4 可印区并判 V7 fail", () => {
  for (const id of ["flow-tb-12", "flow-tb-16"]) {
    const item = metricsFor(id);
    assert.equal(item.figures[0]!.fits_printable_area, false, `${id} 应超出可印区`);
    assert.ok(pageFitFindings(item) > 0, `${id} 应报 V7 page_fit`);
  }
  // 正向对照：8 步流程图仍在可印区内且无 fail
  const ok = metricsFor("flow-tb-8");
  assert.equal(ok.figures[0]!.fits_printable_area, true);
  assert.equal(ok.fail_findings, 0);
});

test("介质锚定：打印字高不足时报 V7 font_size warn（Latin 长标注用例）", () => {
  const latin = metricsFor("block-latin-long");
  assert.ok(latin.printed_font_mm.min < 2, `打印字高应低于 2mm，实际 ${latin.printed_font_mm.min}`);
  assert.ok(latin.warn_findings > 0, "应报 V7 font_size warn");
});

test("统一缩放：混排画幅按同文档统一系数缩放，小图随之缩小", () => {
  const mixed = metricsFor("uniform-zoom-mixed");
  assert.ok(mixed.zoom < 1, "存在超高图时统一缩放应小于 1");
  assert.equal(new Set(mixed.figures.map(figure => figure.printed_font_mm)).size, 1, "同文档各图打印字高应一致");
  // 小图自身可印区内、但按统一系数缩放后字高与超高图相同
  assert.equal(mixed.page_fit_rate, 0.5);
});

test("名称归一化：同组件跨图「处理模块(20)」/「处理模块20」不得判 V4", () => {
  const item = metricsFor("label-normalization");
  assert.equal(item.rule_hits.V4, undefined, "标注形态差异不应触发 V4");
  assert.equal(item.fail_findings, 0);
});

test("括号按面判定：权利要求漏括号判 V10 fail，正文用括号判 V11 warn", () => {
  const item = metricsFor("bracket-faces");
  assert.equal(item.rule_hits.V10?.fail, 1);
  assert.equal(item.rule_hits.V11?.warn, 1);
});

test("LR 布局画幅：3 节点 LR 方框图落进可印区且无违规", () => {
  const item = metricsFor("block-lr-3node");
  assert.equal(item.figures[0]!.fits_printable_area, true);
  assert.equal(item.fail_findings, 0);
  assert.equal(item.warn_findings, 0);
});

test("文字面分节：中文成功、英文标题降级、pct 整族不适用（三种情形都在基线里如实可见）", () => {
  const metrics = computeBenchmarkMetrics();
  const us = metrics.cases.find(item => item.id === "flow-tb-8-us");
  assert.ok(us);
  assert.equal(us.spec_faces.sectioned, false, "英文标题不在启发式标题集内，应如实降级");
  assert.match(us.spec_faces.reason, /未找到说明书小节标题/u);

  const cn = metrics.cases.find(item => item.id === "flow-tb-8");
  assert.ok(cn);
  assert.equal(cn.spec_faces.sectioned, true, "中文小节标题应分节成功");

  // pct：V10/V11 依据 CN 细则第 22 条与中文正文惯例，整族不适用 ⇒ 不计为"已分节"
  for (const item of metrics.cases.filter(candidate => candidate.jurisdiction === "pct")) {
    assert.equal(item.spec_faces.sectioned, false, `${item.id}（pct）不应计为已分节`);
  }

  // 其余中文用例全部应当分节成功（分节失败必须是"有原因"的，不允许静默漏分）
  const cnCases = metrics.cases.filter(item => item.jurisdiction === "cn");
  const unsectioned = cnCases.filter(item => !item.spec_faces.sectioned).map(item => item.id);
  assert.deepEqual(unsectioned, [], `中文用例分节失败：${unsectioned.join(", ")}`);
});

test("语义锚点（法域）：图号条件化——cn 单幅有图号、pct/us 单幅无图号，画幅随之变化", () => {
  assert.equal(metricsFor("office-cn-single").caption_rendered, true, "CN 单幅保留图号（指南 4.3 未禁止）");
  assert.equal(metricsFor("office-us-single").caption_rendered, false, "US 单幅不得编号（1.84(u)(1)）");
  assert.equal(metricsFor("numbering-single-numbered").caption_rendered, false, "PCT 单幅不得编号（IP 5.141）");
  assert.equal(metricsFor("office-pct-two").caption_rendered, true, "多幅按档案标注");

  // 画幅确实随编号变化：同一拓扑（4 步 TB）在 CN 比 US 多一条图号标注带
  const cnHeight = metricsFor("office-cn-single").figures[0]!.height_mm;
  const usHeight = metricsFor("office-us-single").figures[0]!.height_mm;
  assert.ok(cnHeight - usHeight > 5, `CN 画幅应多出标注带（cn ${cnHeight} vs us ${usHeight}）`);
});

test("语义锚点（法域）：字高下限按档案取——CN 实践下限 2.0mm、PCT/US 条文 3.2mm", () => {
  assert.deepEqual(metricsFor("office-cn-single").min_char_height_mm, { mm: 2, basis: "practice" });
  assert.deepEqual(metricsFor("office-us-single").min_char_height_mm, { mm: 3.2, basis: "statute" });
  assert.deepEqual(metricsFor("office-pct-two").min_char_height_mm, { mm: 3.2, basis: "statute" });
});

test("语义锚点：编号义务——两幅无图号判 V15 fail；pct 单幅带图号判 V16 warn", () => {
  assert.ok((metricsFor("numbering-missing-multi").rule_hits.V15?.fail ?? 0) >= 1, "多幅缺号应 fail");
  assert.ok((metricsFor("numbering-single-numbered").rule_hits.V16?.warn ?? 0) >= 1, "单幅带号应 warn");
});

test("语义锚点：图面用语规则的法域适用性（CN 判 V12/V13/V14；PCT 不判 V13）", () => {
  const cn = metricsFor("wording-surface-cn");
  assert.ok((cn.rule_hits.V12?.warn ?? 0) >= 1, "CN 应命中 V12（注释/正文引用/尺寸/标点）");
  assert.ok((cn.rule_hits.V13?.warn ?? 0) >= 1, "CN 应命中 V13（非中文词语）");
  assert.ok((cn.rule_hits.V14?.warn ?? 0) >= 1, "CN 应命中 V14（小写字母后缀）");

  const pct = metricsFor("wording-surface-pct");
  assert.equal(pct.rule_hits.V13, undefined, "PCT 不判非中文词语");
  assert.ok((pct.rule_hits.V14?.warn ?? 0) >= 1, "PCT 判标号与括号连用");
  assert.ok((pct.rule_hits.V12?.warn ?? 0) >= 1, "PCT 判比例标注（IP 5.150 / 1.84(k)）");
});

test("语义锚点：档案键落进基线（法域判据可审计）", () => {
  assert.equal(metricsFor("office-cn-single").office, "cnipa");
  assert.equal(metricsFor("office-us-single").office, "uspto");
  assert.equal(metricsFor("office-pct-two").office, "pct");
});

test("确定性：同一输入两次计算完全一致（基线比对的前提）", () => {
  assert.deepEqual(computeBenchmarkMetrics(), computeBenchmarkMetrics());
});

test("collectMetricDrift：指出漂移路径而非整篇打印", () => {
  const baseline = { a: 1, nested: { list: [{ mm: 239.183 }, { mm: 12 }] } };
  assert.deepEqual(collectMetricDrift(baseline, baseline), []);
  assert.deepEqual(collectMetricDrift(baseline, { ...baseline, a: 2 }), ["a: 1 → 2"]);
  assert.deepEqual(collectMetricDrift(baseline, { a: 1, nested: { list: [{ mm: 355 }, { mm: 12 }] } }), [
    "nested.list[0].mm: 239.183 → 355",
  ]);
  assert.deepEqual(collectMetricDrift(baseline, { a: 1, nested: { list: [{ mm: 239.183 }] } }), [
    "nested.list.length: 2 → 1",
  ]);
  assert.deepEqual(collectMetricDrift({ a: 1 }, { a: 1, b: 2 }), ["b: undefined → 2"]);
});

test("parseBaseline：结构不合法即 fail-loud（不得静默当作无基线）", () => {
  assert.throws(() => parseBaseline("[]"), /cases\/totals/u);
  assert.throws(() => parseBaseline('{"cases":[]}'), /cases\/totals/u);
  assert.throws(() => parseBaseline("not json"), SyntaxError);
});
