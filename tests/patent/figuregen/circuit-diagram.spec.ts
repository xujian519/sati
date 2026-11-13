/**
 * src/patent/figuregen — 电路图（kind="circuit"）渲染器测试。
 *
 * 覆盖：每种元件符号的特征画法、连线数与边数一致、未知形状如实回报、
 * 文本转义、黑白不变式、字号取自入参、direction 影响布局。
 *
 * 断言口径：符号特征按**几何**判定（极板是竖线、极板对间距 10、接地横线递减……），
 * 而不是按某个坐标字面量——坐标随布局与包围盒归一变化，按字面量断言会在布局调整后
 * 变成假红。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderCircuitDiagram } from "../../../src/patent/figuregen/circuit-diagram.js";
import type { FigureEdge, FigureNode, FigureSpec } from "../../../src/patent/figuregen/types.js";

const OPTIONS = { fontSizePx: 14, edgeFontSizePx: 12 };

type Line = { x1: number; y1: number; x2: number; y2: number };
type Circle = { cx: number; cy: number; r: number };

/** 解析图元（坐标取 SVG 属性里的数值）。 */
function linesOf(body: string): Line[] {
  const out: Line[] = [];
  const re = /<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g;
  for (const match of body.matchAll(re)) {
    out.push({
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
    });
  }
  return out;
}

/** 连线（带 wire 角色标记的线段）：与元件引线区分开。 */
function wiresOf(body: string): Line[] {
  const out: Line[] = [];
  const re = /<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"[^>]*data-dsh-role="wire"/g;
  for (const match of body.matchAll(re)) {
    out.push({
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
    });
  }
  return out;
}

function circlesOf(body: string): Circle[] {
  const out: Circle[] = [];
  const re = /<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="(-?[\d.]+)"/g;
  for (const match of body.matchAll(re)) {
    out.push({ cx: Number(match[1]), cy: Number(match[2]), r: Number(match[3]) });
  }
  return out;
}

/** 多段折线的顶点（电感方波）。 */
function polylinePointsOf(body: string): string[][] {
  const out: string[][] = [];
  const re = /<polyline points="([^"]+)"/g;
  for (const match of body.matchAll(re)) {
    out.push((match[1] ?? "").split(" "));
  }
  return out;
}

function polygonPointsOf(body: string): string[][] {
  const out: string[][] = [];
  const re = /<polygon points="([^"]+)"/g;
  for (const match of body.matchAll(re)) {
    out.push((match[1] ?? "").split(" "));
  }
  return out;
}

function lengthOf(line: Line): number {
  return Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
}

function isVertical(line: Line): boolean {
  return line.x1 === line.x2 && line.y1 !== line.y2;
}

function isHorizontal(line: Line): boolean {
  return line.y1 === line.y2 && line.x1 !== line.x2;
}

function isDiagonal(line: Line): boolean {
  return line.x1 !== line.x2 && line.y1 !== line.y2;
}

/** 单元件电路。 */
function single(shape: FigureNode["shape"], label = "元件"): FigureSpec {
  return { figure_no: 1, kind: "circuit", nodes: [{ id: "n1", label, shape }], edges: [] };
}

/** 电源 → 电阻 → 接地 的链式电路。 */
function chain(direction?: "LR" | "TB"): FigureSpec {
  const nodes: FigureNode[] = [
    { id: "src", label: "电源", shape: "source" },
    { id: "r1", label: "电阻", shape: "resistor" },
    { id: "gnd", label: "接地", shape: "ground" },
  ];
  const edges: FigureEdge[] = [
    { from: "src", to: "r1" },
    { from: "r1", to: "gnd" },
  ];
  return { figure_no: 1, kind: "circuit", direction, nodes, edges };
}

test("电阻：空心矩形（长边沿流向，LR 视图下宽>高）", () => {
  const body = renderCircuitDiagram(single("resistor"), OPTIONS).body;
  assert.match(body, /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="32" height="18"/);
  // 矩形是空心的（白底黑边），不是实心块
  assert.match(body, /<rect[^>]*fill="#FFFFFF"[^>]*stroke="#000000"/);
});

test("电容：两条垂直于流向的极板线（LR 视图下即两条竖直短线）", () => {
  const body = renderCircuitDiagram(single("capacitor"), OPTIONS).body;
  const lines = linesOf(body);
  const plates = lines.filter(isVertical);
  assert.equal(plates.length, 2);
  // 两块极板相距 10（局部 u = ±5）
  assert.equal(Math.abs(plates[0]!.x1 - plates[1]!.x1), 10);
  // 引线是水平的（与极板正交）
  assert.equal(lines.filter(isHorizontal).length, 2);
});

test("电感：三段方波（IEC 矩形口径，polyline 折线）", () => {
  const body = renderCircuitDiagram(single("inductor"), OPTIONS).body;
  const polylines = polylinePointsOf(body);
  assert.equal(polylines.length, 1);
  // 折线：进线 → 下 → 右 → 上 → 右 → 下 → 右 → 出线（8 个顶点 = 三段方波）
  assert.equal(polylines[0]!.length, 8);
  // 不使用半圆（没有 arc 指令）
  assert.ok(!body.includes("A "));
});

test("二极管：三角形 + 阴极竖条（三角尖端抵住竖条）", () => {
  const body = renderCircuitDiagram(single("diode"), OPTIONS).body;
  const triangles = polygonPointsOf(body);
  assert.equal(triangles.length, 1);
  assert.equal(triangles[0]!.length, 3);
  const verticals = linesOf(body).filter(isVertical);
  assert.equal(verticals.length, 1);
  // 阴极条与三角形尖端的 x 相同
  const apexX = Number((triangles[0]![2] ?? "0,0").split(",")[0]);
  assert.equal(verticals[0]!.x1, apexX);
});

test("电源：圆圈 + 内部 +/− 极性记号", () => {
  const body = renderCircuitDiagram(single("source"), OPTIONS).body;
  const circles = circlesOf(body);
  assert.equal(circles.length, 1);
  assert.equal(circles[0]!.r, 13);
  const lines = linesOf(body);
  // 「+」的横竖两笔 + 「−」的一笔：三条各长 10 的线段
  const short = lines.filter(line => Math.abs(lengthOf(line) - 10) < 0.05);
  assert.equal(short.length, 3);
});

test("接地：竖线 + 三条递减横线", () => {
  const body = renderCircuitDiagram(single("ground"), OPTIONS).body;
  const lines = linesOf(body);
  const verticals = lines.filter(isVertical);
  assert.equal(verticals.length, 1);
  const horizontals = lines.filter(isHorizontal).map(lengthOf);
  // 三条横线：20 / 13 / 6（递减）；另有一条 28 长的引线
  for (const expected of [20, 13, 6]) {
    assert.ok(
      horizontals.some(len => Math.abs(len - expected) < 0.05),
      `缺少长度 ${expected} 的横线（实际 ${horizontals.join(",")}）`,
    );
  }
  const bars = horizontals.filter(len => len < 25).sort((a, b) => b - a);
  assert.deepEqual(bars.slice(0, 3), [20, 13, 6]);
});

test("开关：两个触点 + 一段断开的斜臂", () => {
  const body = renderCircuitDiagram(single("switch"), OPTIONS).body;
  const contacts = circlesOf(body);
  assert.equal(contacts.length, 2);
  assert.deepEqual(
    contacts.map(circle => circle.r),
    [2.5, 2.5],
  );
  const arms = linesOf(body).filter(isDiagonal);
  assert.equal(arms.length, 1);
  // 斜臂末端与右触点不相接（断开）
  const right = contacts[1]!;
  const arm = arms[0]!;
  const gap = Math.hypot(arm.x2 - right.cx, arm.y2 - right.cy);
  assert.ok(gap > right.r, `斜臂与触点相接（间距 ${gap}）`);
});

test("灯泡：圆 + 内部叉", () => {
  const body = renderCircuitDiagram(single("lamp"), OPTIONS).body;
  const circles = circlesOf(body);
  assert.equal(circles.length, 1);
  assert.equal(circles[0]!.r, 13);
  const crosses = linesOf(body).filter(isDiagonal);
  assert.equal(crosses.length, 2);
});

test("电池：长短极板对（长板 24、短板 14）", () => {
  const body = renderCircuitDiagram(single("battery"), OPTIONS).body;
  const verticals = linesOf(body)
    .filter(isVertical)
    .map(lengthOf)
    .sort((a, b) => b - a);
  assert.deepEqual(verticals, [24, 14]);
});

test("未知形状：按普通矩形框处理，并在 unknownShapes 里如实回报", () => {
  const layout = renderCircuitDiagram(
    {
      figure_no: 1,
      kind: "circuit",
      nodes: [
        { id: "a", label: "处理模块", shape: "rect" },
        { id: "b", label: "圆角", shape: "round" },
        { id: "c", label: "电阻", shape: "resistor" },
      ],
      edges: [],
    },
    OPTIONS,
  );
  assert.deepEqual(layout.unknownShapes, ["rect", "round"]);
  // 未知形状画成矩形框（装置框按文字定尺，不是元件符号的固定尺寸）
  const rectWidths = [...layout.body.matchAll(/<rect\s[^>]*?\swidth="([\d.]+)"/g)].map(match => Number(match[1]));
  assert.equal(rectWidths.filter(width => width === 32).length, 1); // 只有电阻是 32
  assert.ok(rectWidths.some(width => width > 32));
  // 已知元件不算未知
  assert.ok(!layout.unknownShapes?.includes("resistor"));
});

test("连线数 = 边数（连线带 wire 角色标记，可与元件引线区分）", () => {
  const layout = renderCircuitDiagram(chain(), OPTIONS);
  assert.equal(wiresOf(layout.body).length, 2);
  // 同一对节点的多条边平行偏移（不重叠成一条）
  const multi = renderCircuitDiagram(
    {
      figure_no: 1,
      kind: "circuit",
      nodes: [
        { id: "a", label: "A", shape: "source" },
        { id: "b", label: "B", shape: "lamp" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    },
    OPTIONS,
  );
  const wires = wiresOf(multi.body);
  assert.equal(wires.length, 2);
  assert.notEqual(wires[0]!.y1, wires[1]!.y1);
});

test("附图标记：元件名旁只画一次可见标号 (ref)", () => {
  const layout = renderCircuitDiagram(
    {
      figure_no: 1,
      kind: "circuit",
      nodes: [{ id: "r1", label: "电阻", shape: "resistor", ref: 20 }],
      edges: [],
    },
    OPTIONS,
  );
  assert.ok(layout.body.includes("电阻(20)"));
  assert.equal(layout.body.split("(20)").length - 1, 1);
  // 已有可见标号时不重复补画
  const already = renderCircuitDiagram(
    {
      figure_no: 1,
      kind: "circuit",
      nodes: [{ id: "r1", label: "电阻(20)", shape: "resistor", ref: 20 }],
      edges: [],
    },
    OPTIONS,
  );
  assert.equal(already.body.split("(20)").length - 1, 1);
});

test("文本转义：label 含 < & 时不产生裸标签", () => {
  const layout = renderCircuitDiagram(single("resistor", "A&B<C>装置"), OPTIONS);
  assert.ok(!layout.body.includes("<C>"));
  assert.ok(!layout.body.includes("&amp;amp;")); // & 只转义一次
  assert.ok(layout.body.includes("A&amp;B&lt;C&gt;装置"));
});

test("黑白不变式：产物不含彩色/灰度/渐变/外部引用", () => {
  const layout = renderCircuitDiagram(chain(), OPTIONS);
  const colors = layout.body.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.ok(colors.length > 0);
  for (const color of colors) {
    assert.ok(color === "#000000" || color === "#FFFFFF", `出现非黑白颜色 ${color}`);
  }
  assert.ok(!/#8/i.test(layout.body));
  assert.ok(!/#c/i.test(layout.body));
  assert.ok(!layout.body.includes("rgb("));
  assert.ok(!layout.body.toLowerCase().includes("gray"));
  assert.ok(!layout.body.toLowerCase().includes("gradient"));
  assert.ok(!layout.body.includes("<image"));
  assert.ok(!layout.body.includes("url("));
});

test("线宽 ≥ 1.5（审查指南一部一章 4.6）", () => {
  const layout = renderCircuitDiagram(chain(), OPTIONS);
  const widths = [...layout.body.matchAll(/stroke-width="([\d.]+)"/g)].map(match => Number(match[1]));
  assert.ok(widths.length > 0);
  for (const width of widths) {
    assert.ok(width >= 1.5, `线宽 ${width} 小于 1.5`);
  }
});

test("字号取自入参（不写死像素值）", () => {
  const layout = renderCircuitDiagram(
    {
      figure_no: 1,
      kind: "circuit",
      nodes: [
        { id: "a", label: "A", shape: "source" },
        { id: "b", label: "B", shape: "lamp" },
      ],
      edges: [{ from: "a", to: "b", label: "信号" }],
    },
    { fontSizePx: 18, edgeFontSizePx: 13 },
  );
  const sizes = [...layout.body.matchAll(/font-size="([\d.]+)"/g)].map(match => match[1]);
  assert.ok(sizes.length > 0);
  const unique = new Set(sizes);
  // 元件名用主字号、连线标注用边字号：两者都来自入参
  assert.deepEqual([...unique].sort(), ["13", "18"]);
});

test("direction 影响布局：LR 连线水平、TB 连线竖直", () => {
  const lr = renderCircuitDiagram(chain("LR"), OPTIONS);
  const tb = renderCircuitDiagram(chain("TB"), OPTIONS);
  assert.notEqual(lr.body, tb.body);
  for (const wire of wiresOf(lr.body)) {
    assert.ok(isHorizontal(wire), "LR 视图下连线应为水平");
  }
  for (const wire of wiresOf(tb.body)) {
    assert.ok(isVertical(wire), "TB 视图下连线应竖直");
  }
  // 画幅随方向改变（横排与竖排的宽高关系不同）
  assert.ok(lr.width > lr.height, "LR 画幅应宽于高");
  assert.ok(tb.height > tb.width, "TB 画幅应高于宽");
});

test("元件名画在符号下方（LR 视图），不在符号内部", () => {
  const layout = renderCircuitDiagram(single("resistor", "电阻"), OPTIONS);
  const rectY = Number(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)"/.exec(layout.body)?.[2] ?? "0");
  const textY = Number(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"/.exec(layout.body)?.[2] ?? "0");
  assert.ok(textY > rectY + 18, `元件名应在符号下方（rect 底 ${rectY + 18}，文字基线 ${textY}）`);
});

test("空电路：返回空片段而不是抛错", () => {
  const layout = renderCircuitDiagram({ figure_no: 1, kind: "circuit", nodes: [], edges: [] }, OPTIONS);
  assert.equal(layout.body, "");
  assert.equal(layout.width, 0);
  assert.deepEqual(layout.unknownShapes, []);
});
