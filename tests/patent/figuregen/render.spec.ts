/**
 * src/patent/figuregen — 布局器与 SVG 渲染器测试。
 *
 * 渲染合规不变式（审查指南 2023 一部一章 4.3/4.6）：黑色线条、白底、无渐变、
 * 无彩色；附图标记以 data-ref 属性内嵌（供核验器回读）；图号"图N"居中标注。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { layoutFigure } from "../../../src/patent/figuregen/layout.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

function chainSpec(direction?: "TB" | "LR"): FigureSpec {
  return {
    figure_no: 1,
    kind: "flowchart",
    ...(direction ? { direction } : {}),
    nodes: [
      { id: "a", label: "开始", shape: "ellipse" },
      { id: "b", label: "接收输入\n(S100)", ref: 100 },
      { id: "c", label: "结束", shape: "ellipse" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };
}

test("布局：TB 链式流程 y 逐层递增", () => {
  const layout = layoutFigure(chainSpec("TB"));
  const byId = new Map(layout.nodes.map(n => [n.node.id, n]));
  assert.ok(byId.get("a")!.y < byId.get("b")!.y);
  assert.ok(byId.get("b")!.y < byId.get("c")!.y);
  assert.equal(layout.edges.length, 2);
});

test("布局：LR 链式流程 x 逐层递增；block 默认 LR", () => {
  const lr = layoutFigure(chainSpec("LR"));
  const byIdLr = new Map(lr.nodes.map(n => [n.node.id, n]));
  assert.ok(byIdLr.get("a")!.x < byIdLr.get("b")!.x);
  assert.ok(byIdLr.get("b")!.x < byIdLr.get("c")!.x);

  const block: FigureSpec = {
    figure_no: 2,
    kind: "block",
    nodes: [
      { id: "in", label: "输入模块(10)", ref: 10 },
      { id: "cpu", label: "处理模块(20)", ref: 20 },
    ],
    edges: [{ from: "in", to: "cpu", label: "原始数据" }],
  };
  const blockLayout = layoutFigure(block);
  const byIdBlock = new Map(blockLayout.nodes.map(n => [n.node.id, n]));
  assert.ok(byIdBlock.get("in")!.x < byIdBlock.get("cpu")!.x);
});

test("布局：判断分支的子节点同层且横向错开", () => {
  const spec: FigureSpec = {
    figure_no: 1,
    kind: "flowchart",
    direction: "TB",
    nodes: [
      { id: "start", label: "开始", shape: "ellipse" },
      { id: "decide", label: "校验通过?", shape: "diamond", ref: 110 },
      { id: "ok", label: "处理数据(S120)", ref: 120 },
      { id: "err", label: "返回错误" },
    ],
    edges: [
      { from: "start", to: "decide" },
      { from: "decide", to: "ok", label: "是" },
      { from: "decide", to: "err", label: "否" },
    ],
  };
  const layout = layoutFigure(spec);
  const byId = new Map(layout.nodes.map(n => [n.node.id, n]));
  assert.equal(byId.get("ok")!.y, byId.get("err")!.y);
  assert.notEqual(byId.get("ok")!.x, byId.get("err")!.x);

  const labeledEdge = layout.edges.find(e => e.edge.label === "是");
  assert.ok(labeledEdge?.labelAt, "判断分支边标签应有落点坐标");
});

test("布局：多行标签节点更高；无环图外环回边被断开不致死循环", () => {
  const multiline = layoutFigure({
    figure_no: 1,
    kind: "flowchart",
    nodes: [
      { id: "a", label: "单行" },
      { id: "b", label: "第一行\n第二行" },
    ],
    edges: [],
  });
  const byId = new Map(multiline.nodes.map(n => [n.node.id, n]));
  assert.ok(byId.get("b")!.height > byId.get("a")!.height);

  const cyclic = layoutFigure({
    figure_no: 1,
    kind: "flowchart",
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  });
  assert.equal(cyclic.nodes.length, 2);
});

const SNAPSHOT_SPEC: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  direction: "TB",
  nodes: [
    { id: "a", label: "开始", shape: "ellipse" },
    { id: "b", label: "处理模块(20)", ref: 20 },
    { id: "c", label: "结束", shape: "ellipse" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ],
};

test("渲染：确定性输出（同输入逐字节一致）", () => {
  const first = renderFigureSvg(SNAPSHOT_SPEC);
  const second = renderFigureSvg(SNAPSHOT_SPEC);
  assert.equal(first.svg, second.svg);
});

test("渲染：黑白合规不变式——仅 #000000/#FFFFFF，无渐变无彩色函数", () => {
  const { svg } = renderFigureSvg(SNAPSHOT_SPEC);
  const colors = svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.ok(colors.length > 0, "SVG 应显式声明颜色");
  for (const color of colors) {
    assert.ok(color.toUpperCase() === "#000000" || color.toUpperCase() === "#FFFFFF", `发现非黑白颜色 ${color}`);
  }
  assert.ok(!/gradient/i.test(svg));
  assert.ok(!/rgb\(|rgba\(|hsl\(/i.test(svg));
});

test("渲染：附图标记 data-ref 内嵌；无标记节点不携带该属性；图号居中标注", () => {
  const { svg } = renderFigureSvg(SNAPSHOT_SPEC);
  assert.ok(svg.includes('data-ref="20"'));
  assert.ok(svg.includes("处理模块(20)"));
  // "开始"节点（ref undefined）所在分组不得携带 data-ref
  const startGroup = svg.slice(svg.indexOf('id="n-a"'), svg.indexOf('id="n-b"'));
  assert.ok(!startGroup.includes("data-ref"));
  assert.match(svg, /<text[^>]*>图1<\/text>/);
});

test("渲染：边以带箭头折线绘制，边标签文本存在", () => {
  const branch: FigureSpec = {
    figure_no: 1,
    kind: "flowchart",
    direction: "TB",
    nodes: [
      { id: "decide", label: "通过?", shape: "diamond" },
      { id: "ok", label: "处理" },
      { id: "err", label: "报错" },
    ],
    edges: [
      { from: "decide", to: "ok", label: "是" },
      { from: "decide", to: "err", label: "否", dashed: true },
    ],
  };
  const { svg } = renderFigureSvg(branch);
  assert.ok(svg.includes("<marker"), "应定义箭头 marker");
  assert.ok((svg.match(/<polyline/g) ?? []).length === 2);
  assert.ok(svg.includes(">是<"));
  assert.ok(svg.includes(">否<"));
  assert.ok(svg.includes("stroke-dasharray"), "dashed 边应有虚线样式");
});
