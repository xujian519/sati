/**
 * src/patent/figuregen — 附图标号一致性归一测试。
 *
 * 覆盖：label 可见标号解析、ref 回填、可见标号与 ref 的冲突信号、标号分配（100 系列 /
 * 步进 / 显式 / reserved / 冲突抛错）、自动分配，以及两处渲染器（内置 SVG 与 Graphviz DOT）
 * 的"缺则补画、已含则不重复画"。
 *
 * 形态口径与 `check-context.ts` 的 `stripRefMark` 同源（半/全角括号 + 1–3 位数字）；
 * 裸数字形态（「处理模块20」）属说明书正文惯例，不算图面标记。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildFigureDot } from "../../../src/patent/figuregen/dot.js";
import {
  assignNumerals,
  autoAssignNumerals,
  applyVisibleNumerals,
  backfillRefsFromLabels,
  findRefsMissingInLabels,
  labelContainsNumeral,
  NumeralAssignError,
  numeralSeriesStart,
  parseLabelNumeral,
  withVisibleNumeral,
} from "../../../src/patent/figuregen/numeral-assign.js";
import { checkFigureRendering } from "../../../src/patent/figuregen/render-check.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

test("label 可见标号解析：括号形态取标记，裸数字形态不算图面标记", () => {
  assert.equal(parseLabelNumeral("处理模块(20)"), 20);
  assert.equal(parseLabelNumeral("混料器（30）"), 30, "全角括号同形态");
  assert.equal(parseLabelNumeral("处理模块 ( 40 )"), 40, "括号内外空白同形态");
  assert.equal(parseLabelNumeral("处理模块"), undefined);
  assert.equal(parseLabelNumeral("处理模块20"), undefined, "裸数字属说明书正文惯例");
  assert.equal(parseLabelNumeral("处理模块(1234)"), undefined, "四位数字不属本仓标记形态");
  assert.equal(parseLabelNumeral("步骤(S100)"), undefined, "步骤编号不是附图标记");
});

test("label 可见标号解析：多行标签取尾部标记；含任意位置即可判包含", () => {
  assert.equal(parseLabelNumeral("混料器\n储料仓(30)"), 30);
  assert.equal(labelContainsNumeral("处理模块(20)", 20), true);
  assert.equal(labelContainsNumeral("处理模块(20)", 30), false);
});

test("backfill：label 自带可见标号而缺 ref 时补 ref；不改入参、不改 label 文本", () => {
  const figure: FigureSpec = {
    figure_no: 1,
    kind: "block",
    nodes: [
      { id: "cpu", label: "处理模块(20)" },
      { id: "mem", label: "存储器", ref: 30 },
      { id: "io", label: "输入模块" },
    ],
    edges: [],
  };
  const filled = backfillRefsFromLabels(figure);
  assert.equal(filled.nodes[0].ref, 20, "label 可见标号应回填为 ref");
  assert.equal(filled.nodes[0].label, "处理模块(20)", "不改 label 文本");
  assert.equal(filled.nodes[1].ref, 30, "已有 ref 不动");
  assert.equal(filled.nodes[2].ref, undefined, "无可见标号不补");
  assert.equal(figure.nodes[0].ref, undefined, "入参不得被改");
  assert.notEqual(filled, figure);
});

test("冲突信号：label 标号 ≠ ref ⇒ 该 ref 需在图面补画（不一致信号不被吞掉）", () => {
  const figure: FigureSpec = {
    figure_no: 1,
    kind: "block",
    nodes: [
      { id: "cpu", label: "处理模块(30)", ref: 20 },
      { id: "mem", label: "存储器(30)", ref: 30 },
    ],
    edges: [],
  };
  assert.deepEqual(findRefsMissingInLabels(figure), [{ id: "cpu", ref: 20 }]);
});

test("标号系列起点：100 + 100 × (图号 − 1)；图号越界报错", () => {
  assert.equal(numeralSeriesStart(1), 100);
  assert.equal(numeralSeriesStart(2), 200);
  assert.equal(numeralSeriesStart(3), 300);
  assert.throws(
    () => numeralSeriesStart(0),
    (error: unknown) => error instanceof NumeralAssignError && error.code === "invalid_numeral_range",
  );
});

test("assignNumerals：默认 100 系列、步进 2；显式优先；reserved 跳过", () => {
  const auto = assignNumerals(["a", "b", "c"], { figureNumber: 1 });
  assert.deepEqual(
    auto.map(item => [item.id, item.numeral, item.explicit]),
    [
      ["a", 100, false],
      ["b", 102, false],
      ["c", 104, false],
    ],
  );

  const stepped = assignNumerals(["a", "b"], { figureNumber: 2, step: 5 });
  assert.deepEqual(
    stepped.map(item => item.numeral),
    [200, 205],
  );

  const explicit = assignNumerals(["a", "b", "c"], { figureNumber: 1, explicit: { b: "20" } });
  assert.deepEqual(
    explicit.map(item => [item.id, item.numeral, item.explicit]),
    [
      ["a", 100, false],
      ["b", 20, true],
      ["c", 102, false],
    ],
  );

  const reserved = assignNumerals(["a", "b"], { figureNumber: 1, reserved: ["100"] });
  assert.deepEqual(
    reserved.map(item => item.numeral),
    [102, 104],
  );
});

test("assignNumerals：同号冲突与非法取值一律抛 NumeralAssignError", () => {
  assert.throws(
    () => assignNumerals(["a", "b"], { explicit: { a: "20", b: "20" } }),
    (error: unknown) => error instanceof NumeralAssignError && error.code === "conflicting_numeral",
  );
  assert.throws(
    () => assignNumerals(["a"], { reserved: ["100"], explicit: { a: "100" } }),
    (error: unknown) => error instanceof NumeralAssignError && error.code === "conflicting_numeral",
  );
  assert.throws(
    () => assignNumerals(["a"], { explicit: { a: "20A" } }),
    (error: unknown) => error instanceof NumeralAssignError && error.code === "invalid_numeral_range",
  );
  assert.throws(
    () => assignNumerals(["a"], { step: 0 }),
    (error: unknown) => error instanceof NumeralAssignError && error.code === "invalid_numeral_range",
  );
});

test("autoAssignNumerals：跳过已有 ref 的节点与 label 已带可见标号的节点", () => {
  const figure: FigureSpec = {
    figure_no: 1,
    kind: "block",
    nodes: [
      { id: "a", label: "开始" },
      { id: "b", label: "处理模块", ref: 20 },
      { id: "c", label: "存储器(30)" },
    ],
    edges: [],
  };
  const { figure: assigned, assignments } = autoAssignNumerals(figure, {});
  assert.deepEqual(
    assignments.map(item => [item.id, item.numeral]),
    [["a", 100]],
  );
  assert.equal(assigned.nodes[0].ref, 100);
  assert.equal(assigned.nodes[1].ref, 20, "已有 ref 不参与分配");
  assert.equal(assigned.nodes[2].ref, undefined, "label 已带可见标号的节点不参与分配");
  assert.equal(figure.nodes[0].ref, undefined, "入参不得被改");

  const reserved = autoAssignNumerals(figure, { reserved: ["100"] });
  assert.deepEqual(
    reserved.assignments.map(item => item.numeral),
    [102],
  );
});

test("图面补画辅助：缺则补、已含则不改；补在首行（组件名行）", () => {
  assert.equal(withVisibleNumeral("处理模块", 20), "处理模块(20)");
  assert.equal(withVisibleNumeral("处理模块(20)", 20), "处理模块(20)", "已含不重复画");
  assert.equal(withVisibleNumeral("混料器\n储料仓", 20), "混料器(20)\n储料仓");
  assert.equal(withVisibleNumeral("处理模块", 0), "处理模块", "非法标号不补画");
});

test("内置 SVG 渲染器：label 缺可见标号时按 ref 补画 (ref)；已含则不重复画", () => {
  const spec: FigureSpec = {
    figure_no: 1,
    kind: "block",
    nodes: [
      { id: "cpu", label: "处理模块", ref: 20 },
      { id: "mem", label: "存储器(30)", ref: 30 },
    ],
    edges: [{ from: "cpu", to: "mem", label: "是" }],
  };
  const { svg } = renderFigureSvg(spec);
  assert.ok(svg.includes(">处理模块(20)</text>"), "缺可见标号应补画");
  assert.ok(svg.includes('data-ref="20"'), "data-ref 仍照写");
  assert.equal((svg.match(/\(20\)/gu) ?? []).length, 1, "不得出现「处理模块(20)(20)」");
  assert.equal((svg.match(/\(30\)/gu) ?? []).length, 1, "已带标号的节点不重复画");
  assert.ok(svg.includes(">是</text>"), "边标签不处理");
});

test("Graphviz DOT：节点 label 同理补画 (ref)；已含则不重复画", () => {
  const spec: FigureSpec = {
    figure_no: 1,
    kind: "block",
    nodes: [
      { id: "cpu", label: "处理模块", ref: 20 },
      { id: "mem", label: "存储器(30)", ref: 30 },
    ],
    edges: [],
  };
  const dot = buildFigureDot(spec);
  assert.ok(dot.includes('label="处理模块(20)"'), "缺可见标号应补画");
  assert.equal((dot.match(/\(20\)/gu) ?? []).length, 1, "不得出现「处理模块(20)(20)」");
  assert.equal((dot.match(/\(30\)/gu) ?? []).length, 1, "已带标号的节点不重复画");
});

test("接线用归一：applyVisibleNumerals 把 ref 写进 label，渲染出的文字与盒宽同源（RC1 不报）", () => {
  const figure: FigureSpec = {
    figure_no: 1,
    kind: "block",
    nodes: [{ id: "cpu", label: "处理模块", ref: 20 }],
    edges: [],
  };
  const normalized = applyVisibleNumerals(figure);
  assert.equal(normalized.nodes[0].label, "处理模块(20)");
  assert.equal(figure.nodes[0].label, "处理模块", "入参不得被改");

  // label 先带上标号 ⇒ 盒宽按带标号的文本算 ⇒ 文字不被框线贯穿（RC1 不报）。
  const findings = checkFigureRendering(renderFigureSvg(normalized).svg).findings;
  assert.equal(
    findings.filter(finding => finding.check === "text-crossed-by-line").length,
    0,
    `文字被框线贯穿：${findings.map(finding => finding.message).join("；")}`,
  );
});
