/**
 * src/patent/figuregen — 确定性校验器（V1–V4）表驱动测试。
 *
 * 规则依据：专利法实施细则（2023）第 21 条——附图按"图1，图2……"顺序编号；
 * 说明书文字部分中未提及的附图标记不得在附图中出现，附图中未出现的附图标记
 * 不得在说明书文字部分中提及；表示同一组成部分的附图标记应当一致。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";
import { checkFigures } from "../../../src/patent/figuregen/check.js";

function flowchart(figureNo: number, refs: (number | undefined)[], labels?: string | string[]): FigureSpec {
  const labelList = labels === undefined ? undefined : Array.isArray(labels) ? labels : [labels];
  return {
    figure_no: figureNo,
    kind: "flowchart",
    nodes: refs.map((ref, i) => ({
      id: `fig${figureNo}-n${i}`,
      label: labelList?.[i] ?? (ref === undefined ? `步骤${i}` : `模块(${ref})`),
      ...(ref === undefined ? {} : { ref }),
    })),
    edges: [],
  };
}

test("V1 图号连续：1..N 通过", () => {
  const result = checkFigures(
    [flowchart(1, [10]), flowchart(2, [20]), flowchart(3, [30])],
    "处理模块(10)、处理模块(20)、处理模块(30)",
  );
  const v1 = result.findings.filter(f => f.rule === "V1");
  assert.deepEqual(v1, []);
  assert.equal(result.ok, true);
});

test("V1 图号跳号/缺号/重复/空图均 FAIL", () => {
  // 跳号 [1,3]
  const gap = checkFigures([flowchart(1, []), flowchart(3, [])], "");
  assert.ok(gap.findings.some(f => f.rule === "V1" && f.severity === "fail"));

  // 缺号 [2,3]（应从 1 起）
  const missing = checkFigures([flowchart(2, []), flowchart(3, [])], "");
  assert.ok(missing.findings.some(f => f.rule === "V1" && f.severity === "fail"));

  // 重复图号 [1,1]
  const dup = checkFigures([flowchart(1, []), flowchart(1, [])], "");
  assert.ok(dup.findings.some(f => f.rule === "V1" && f.severity === "fail"));

  // 空附图集
  const empty = checkFigures([], "");
  assert.ok(empty.findings.some(f => f.rule === "V1" && f.severity === "fail"));
  assert.equal(empty.ok, false);
});

test("V2 图→文：图内标记未在说明书文字部分出现则 FAIL 并附证据", () => {
  const result = checkFigures([flowchart(1, [20])], "输入模块(10)接收数据。");
  const v2 = result.findings.filter(f => f.rule === "V2" && f.severity === "fail");
  assert.equal(v2.length, 1);
  assert.ok(v2[0].evidence?.some(e => e.includes("20")));
  assert.equal(result.ok, false);
});

test("V2 词边界：S20 / 120 不算标记 20 出现", () => {
  const result = checkFigures([flowchart(1, [20])], "执行步骤S20，共120项。");
  assert.ok(result.findings.some(f => f.rule === "V2" && f.severity === "fail"));
});

test("V2 正向：括号/顿号列举形式的标记命中", () => {
  const result = checkFigures(
    [flowchart(1, [10, 20, 30])],
    "一种装置，包括输入模块(10)、处理模块(20)；所述装置还包括输出模块30。",
  );
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V2"),
    [],
  );
  assert.equal(result.ok, true);
});

test("V3 文→图：说明书括号标记未出现于任何附图仅 WARN（保守，人工确认）", () => {
  const result = checkFigures([flowchart(1, [10])], "输入模块(10)，以及散热风扇(40)。");
  const v3 = result.findings.filter(f => f.rule === "V3");
  assert.equal(v3.length, 1);
  assert.equal(v3[0].severity, "warn");
  assert.ok(v3[0].evidence?.some(e => e.includes("40")));
  assert.equal(result.ok, true);
});

test("V3 非括号数字不触发（如步骤 S20、数量 120）", () => {
  const result = checkFigures([flowchart(1, [10])], "输入模块(10)；执行步骤S20；共120项；三步法。");
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V3"),
    [],
  );
});

test("V4 一致性：同一 ref 跨图对应不同名称 FAIL", () => {
  const fig1 = flowchart(1, [20], "处理模块(20)");
  const fig2: FigureSpec = {
    figure_no: 2,
    kind: "block",
    nodes: [
      { id: "cpu", label: "处理器(20)", ref: 20 },
      { id: "mem", label: "存储器(30)", ref: 30 },
    ],
    edges: [],
  };
  const result = checkFigures([fig1, fig2], "处理模块(20)。图2中：处理器(20)；存储器(30)。");
  const v4 = result.findings.filter(f => f.rule === "V4" && f.severity === "fail");
  assert.equal(v4.length, 1);
  assert.ok(v4[0].evidence?.some(e => e.includes("20")));
});

test("V4 一致性：同一节点 id 跨图标记不一致 FAIL；名称一致 PASS", () => {
  const fig1 = flowchart(1, [20], "处理模块(20)");
  const fig2: FigureSpec = {
    figure_no: 2,
    kind: "block",
    nodes: [{ id: fig1.nodes[0].id, label: "处理模块(30)", ref: 30 }],
    edges: [],
  };
  const mismatch = checkFigures([fig1, fig2], "处理模块(20)；处理模块(30)。");
  assert.ok(mismatch.findings.some(f => f.rule === "V4" && f.severity === "fail"));

  const consistent = checkFigures([fig1, flowchart(2, [20], "处理模块(20)")], "处理模块(20)。");
  assert.deepEqual(
    consistent.findings.filter(f => f.rule === "V4"),
    [],
  );
});

test("V4 一致性：同图内重复标记指向不同节点 FAIL", () => {
  const fig: FigureSpec = {
    figure_no: 1,
    kind: "block",
    nodes: [
      { id: "a", label: "输入模块(10)", ref: 10 },
      { id: "b", label: "输出模块(10)", ref: 10 },
    ],
    edges: [],
  };
  const result = checkFigures([fig], "输入模块(10)；输出模块(10)。");
  assert.ok(result.findings.some(f => f.rule === "V4" && f.severity === "fail"));
});

test("汇总：refsInFigures / refsInText 正确回流", () => {
  const result = checkFigures([flowchart(1, [10, 20])], "模块(10)；另有风扇(40)。");
  assert.deepEqual(
    result.refsInFigures.sort((a, b) => a - b),
    [10, 20],
  );
  assert.deepEqual(result.refsInText, [10, 40]);
});
