/**
 * src/patent/figuregen — 附图说明草稿文本测试。
 *
 * 说明书七部分之"附图说明"（细则第 20 条）章节的结构化草稿：
 * 图N 为……；附图标记说明（同一组成部分标记一致，细则第 21 条）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildFigureBriefDraft } from "../../../src/patent/figuregen/brief.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

const FLOW: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "start", label: "开始", shape: "ellipse" },
    { id: "recv", label: "接收输入(100)", ref: 100 },
  ],
  edges: [{ from: "start", to: "recv" }],
};

const BLOCK: FigureSpec = {
  figure_no: 2,
  kind: "block",
  nodes: [
    { id: "in", label: "输入模块(10)", ref: 10 },
    { id: "cpu", label: "处理模块(20)", ref: 20 },
  ],
  edges: [],
};

test("附图说明：图号、图类型措辞与发明名称齐备", () => {
  const text = buildFigureBriefDraft([FLOW, BLOCK], { inventionName: "一种数据处理装置" });
  assert.ok(text.includes("附图说明"));
  assert.ok(text.includes("图1为本发明实施例提供的一种数据处理装置的方法流程示意图"));
  assert.ok(text.includes("图2为本发明实施例提供的一种数据处理装置的结构框图"));
});

test("实用新型措辞切换；缺省名称时不出现名称段", () => {
  const utility = buildFigureBriefDraft([BLOCK], { documentKind: "utility" });
  assert.ok(utility.includes("本实用新型"));
  assert.ok(!utility.includes("本发明"));

  const nameless = buildFigureBriefDraft([BLOCK]);
  assert.ok(nameless.includes("图2为本发明实施例提供的结构框图"));
});

test("附图标记说明：跨图去重、按标记升序、名称剥离括号标记", () => {
  const text = buildFigureBriefDraft([FLOW, BLOCK]);
  const markerLine = text.split("\n").find(line => line.startsWith("附图标记说明"));
  assert.equal(markerLine, "附图标记说明：10—输入模块；20—处理模块；100—接收输入；");
});

test("全部节点无标记时省略附图标记说明整段", () => {
  const noRefs = buildFigureBriefDraft([
    { figure_no: 1, kind: "flowchart", nodes: [{ id: "a", label: "开始" }], edges: [] },
  ]);
  assert.ok(!noRefs.includes("附图标记说明"));
});

test("多图乱序输入按 figure_no 升序输出", () => {
  const text = buildFigureBriefDraft([BLOCK, FLOW]);
  assert.ok(text.indexOf("图1为") < text.indexOf("图2为"));
});

test("附图说明：状态图/层级图措辞（中英各一套）", () => {
  const state: FigureSpec = { figure_no: 1, kind: "state", nodes: [{ id: "a", label: "待机" }], edges: [] };
  const hierarchy: FigureSpec = { figure_no: 2, kind: "hierarchy", nodes: [{ id: "s", label: "系统" }], edges: [] };

  const cn = buildFigureBriefDraft([state, hierarchy]);
  assert.ok(cn.includes("图1为本发明实施例提供的状态转移示意图"));
  assert.ok(cn.includes("图2为本发明实施例提供的层级结构示意图"));

  const us = buildFigureBriefDraft([state, hierarchy], { jurisdiction: "us" });
  assert.ok(us.includes("FIG. 1 is a state transition diagram of a process according to an embodiment."));
  assert.ok(us.includes("FIG. 2 is a hierarchical block diagram of a system according to an embodiment."));
});
