/**
 * src/patent/figuregen — 时序图渲染器测试。
 *
 * 覆盖：参与者/生命线/消息的数量对应、箭头 marker 在 defs 里、自消息回环、
 * 文本转义、黑白不变式、字号取自入参、虚线消息、可见标号只画一次、
 * 线宽下限与坐标精度（审查指南一部一章 4.3/4.6 的构造期不变式）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { glyphBox } from "../../../src/patent/figuregen/glyph-box.js";
import { renderSequenceDiagram } from "../../../src/patent/figuregen/sequence-diagram.js";
import type { FigureEdge, FigureNode, FigureSpec } from "../../../src/patent/figuregen/types.js";

const OPTIONS = { fontSizePx: 14, edgeFontSizePx: 12 };

/** 时序图 spec：nodes = 参与者（顺序即列序），edges = 消息（顺序即时序）。 */
function spec(nodes: FigureNode[], edges: FigureEdge[]): FigureSpec {
  return { figure_no: 1, kind: "sequence", nodes, edges };
}

const SPEC = spec(
  [
    { id: "u", label: "用户" },
    { id: "m", label: "移动终端", ref: 20 },
    { id: "s", label: "服务器" },
  ],
  [
    { from: "u", to: "m", label: "请求" },
    { from: "m", to: "s", label: "转发" },
    { from: "s", to: "m", label: "应答", dashed: true },
    { from: "m", to: "m", label: "本地处理" },
  ],
);

/** 子串出现次数。 */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** 取带指定 id 的元素标签原文（自 id 前的 "<" 到该元素的 ">"）。 */
function elementById(body: string, id: string): string | undefined {
  const at = body.indexOf(`id="${id}"`);
  if (at === -1) return undefined;
  const start = body.lastIndexOf("<", at);
  const end = body.indexOf(">", at);
  if (start === -1 || end === -1) return undefined;
  return body.slice(start, end + 1);
}

/** 元素属性值。 */
function attr(element: string | undefined, name: string): string | undefined {
  if (element === undefined) return undefined;
  const match = new RegExp(`${name}="([^"]*)"`, "u").exec(element);
  return match?.[1];
}

test("参与者数 = 节点数，生命线数 = 参与者数", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  assert.equal(count(layout.body, 'id="n-'), SPEC.nodes.length);
  assert.equal(count(layout.body, 'id="seq-lifeline-'), SPEC.nodes.length);
});

test("消息数 = 边数，箭头 marker 写在 defs 里且被消息引用", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  assert.equal(count(layout.body, 'id="seq-msg-'), SPEC.edges.length);
  assert.ok(layout.defs !== undefined);
  assert.ok(layout.defs.includes("<marker"));
  assert.ok(layout.defs.includes('id="seq-arrow"'));
  assert.ok(layout.body.includes('marker-end="url(#seq-arrow)"'));
});

test("自消息在生命线右侧画折返回环（箭头回到生命线）", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  const loop = elementById(layout.body, "seq-msg-3");
  assert.ok(loop !== undefined);
  assert.ok(loop.includes("<polyline"));
  assert.ok(loop.includes('marker-end="url(#seq-arrow)"'));
  const points = (attr(loop, "points") ?? "").split(" ").map(pair => pair.split(",").map(Number));
  assert.equal(points.length, 4);
  const startX = points[0]?.[0] ?? 0;
  const startY = points[0]?.[1] ?? 0;
  const rightX = points[1]?.[0] ?? 0;
  const rightY = points[1]?.[1] ?? 0;
  const lowerY = points[2]?.[1] ?? 0;
  const endX = points[3]?.[0] ?? 0;
  assert.equal(endX, startX); // 起点与终点同在生命线上（折返回来）
  assert.ok(rightX > startX); // 向右伸出
  assert.equal(rightY, startY); // 水平出发
  assert.ok(lowerY > startY); // 折返向下
});

test("消息文本里的尖括号与 ampersand 被转义（不产生裸标签）", () => {
  const layout = renderSequenceDiagram(
    spec(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      [{ from: "a", to: "b", label: '<script>alert(1)</script> & "q"' }],
    ),
    OPTIONS,
  );
  assert.ok(!layout.body.includes("<script"));
  assert.ok(layout.body.includes("&lt;script&gt;"));
  // 只允许五个命名实体：裸 & 会破坏 XML 结构
  assert.ok(!/&(?!(?:amp|lt|gt|quot|apos);)/u.test(layout.body));
});

test("产物只有黑白（无彩色、灰度与渐变）", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  const all = `${layout.body}${layout.defs ?? ""}`;
  assert.ok(!all.includes("#8"));
  assert.ok(!all.includes("#c"));
  assert.ok(!all.includes("rgb("));
  assert.ok(!all.toLowerCase().includes("gray"));
  for (const match of all.matchAll(/(?:fill|stroke)="([^"]*)"/g)) {
    assert.ok(["#000000", "#FFFFFF", "none"].includes(match[1] ?? ""), `非法颜色：${match[1]}`);
  }
});

test("字号取自入参（改入参则图面 font-size 随之改变）", () => {
  const base = renderSequenceDiagram(SPEC, { fontSizePx: 14, edgeFontSizePx: 12 });
  assert.ok(base.body.includes('font-size="14"'));
  assert.ok(base.body.includes('font-size="12"'));
  const scaled = renderSequenceDiagram(SPEC, { fontSizePx: 20, edgeFontSizePx: 16 });
  assert.ok(scaled.body.includes('font-size="20"'));
  assert.ok(scaled.body.includes('font-size="16"'));
  assert.ok(!scaled.body.includes('font-size="14"'));
  assert.ok(!scaled.body.includes('font-size="12"'));
});

test("dashed 消息画虚线，实线消息不画虚线，生命线是虚线", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  const dashed = elementById(layout.body, "seq-msg-2");
  assert.ok((dashed ?? "").includes("stroke-dasharray"));
  const solid = elementById(layout.body, "seq-msg-0");
  assert.ok(solid !== undefined);
  assert.ok(!solid.includes("stroke-dasharray"));
  const lifeline = elementById(layout.body, "seq-lifeline-u");
  assert.ok((lifeline ?? "").includes("stroke-dasharray"));
});

test("带 ref 的参与者：可见标号补进 label 且只画一次", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  assert.equal(count(layout.body, "(20)"), 1);
  assert.ok(layout.body.includes("移动终端(20)"));
  assert.ok(layout.body.includes('data-ref="20"'));
});

test("label 已带可见标号时不重复补画", () => {
  const layout = renderSequenceDiagram(spec([{ id: "a", label: "模块(20)", ref: 20 }], []), OPTIONS);
  assert.equal(count(layout.body, "(20)"), 1);
});

test("线宽均不低于 1.5", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  for (const match of layout.body.matchAll(/stroke-width="([\d.]+)"/g)) {
    assert.ok(Number(match[1]) >= 1.5, `线宽 ${match[1]} 低于 1.5`);
  }
});

test("坐标无浮点尾巴（最多一位小数）", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  assert.ok(!/\d+\.\d{2,}/u.test(layout.body));
});

test("消息文本画在线的上方，自消息文本在回环右侧", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  const line = elementById(layout.body, "seq-msg-0");
  const lineY = Number(attr(line, "y1"));
  assert.ok(Number.isFinite(lineY));
  const label = /<text[^>]*y="([\d.]+)"[^>]*>请求<\/text>/u.exec(layout.body);
  assert.ok(label !== null);
  assert.ok(Number(label?.[1]) < lineY); // 文本在消息线之上
  const loop = elementById(layout.body, "seq-msg-3");
  const points = (attr(loop, "points") ?? "").split(" ").map(pair => pair.split(",").map(Number));
  const loopRight = Math.max(...points.map(point => point[0] ?? 0));
  const selfLabel = /<text[^>]*x="([\d.]+)"[^>]*>本地处理<\/text>/u.exec(layout.body);
  assert.ok(selfLabel !== null);
  assert.ok(Number(selfLabel?.[1]) > loopRight); // 文本在回环右侧
});

test("画布随参与者与消息增长，参与者框落在画布内", () => {
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  const narrow = renderSequenceDiagram(spec([{ id: "a", label: "A" }], []), OPTIONS);
  assert.ok(layout.width > narrow.width);
  assert.ok(layout.height > narrow.height);
  const group = /<g id="n-s"[^>]*>[\s\S]*?<\/g>/u.exec(layout.body)?.[0];
  const rect = /<rect[^>]*>/u.exec(group ?? "")?.[0];
  const right = Number(attr(rect, "x")) + Number(attr(rect, "width"));
  assert.ok(right <= layout.width);
});

test("引用不存在参与者的消息被跳过（不猜位置）", () => {
  const layout = renderSequenceDiagram(
    spec([{ id: "a", label: "A" }], [{ from: "a", to: "ghost", label: "?" }]),
    OPTIONS,
  );
  assert.equal(count(layout.body, 'id="seq-msg-'), 0);
});

test("参与者文字与框线留足 1.5mm 净距（按复核侧同一占位框模型量）", () => {
  // 1.5mm @96dpi = 5.67 用户单位；占位框模型与复核侧同源（glyph-box.ts）。
  const MIN_CLEARANCE = (1.5 / 25.4) * 96;
  const layout = renderSequenceDiagram(SPEC, OPTIONS);
  const group = /<g id="n-m"[^>]*>[\s\S]*?<\/g>/u.exec(layout.body)?.[0] ?? "";
  const rect = /<rect[^>]*>/u.exec(group)?.[0] ?? "";
  const text = /<text[^>]*>[^<]*<\/text>/u.exec(group)?.[0] ?? "";
  const left = Number(attr(rect, "x"));
  const top = Number(attr(rect, "y"));
  const right = left + Number(attr(rect, "width"));
  const bottom = top + Number(attr(rect, "height"));
  const content = /<text[^>]*>([^<]*)<\/text>/u.exec(text)?.[1] ?? "";
  const box = glyphBox(content, [Number(attr(text, "x")), Number(attr(text, "y"))], 14, "middle");
  assert.ok(box.minX - left >= MIN_CLEARANCE, "文字距框左边过近");
  assert.ok(right - box.maxX >= MIN_CLEARANCE, "文字距框右边过近");
  assert.ok(box.minY - top >= MIN_CLEARANCE, "文字距框上边过近");
  assert.ok(bottom - box.maxY >= MIN_CLEARANCE, "文字距框下边过近");
});

test("底部预留图号标注带（caption=false 时收紧画布）", () => {
  const withCaption = renderSequenceDiagram(SPEC, OPTIONS);
  const withoutCaption = renderSequenceDiagram(SPEC, { ...OPTIONS, caption: false });
  assert.ok(withCaption.height > withoutCaption.height);
  // 生命线末端离画布底 ≥32px ⇒ 调用方画在 height−16 附近的图号文字不会被生命线穿过。
  const lifelineBottom = (body: string): number => {
    let bottom = 0;
    for (const match of body.matchAll(/id="seq-lifeline-[^"]*"[^>]*y2="([\d.]+)"/g)) {
      bottom = Math.max(bottom, Number(match[1]));
    }
    return bottom;
  };
  assert.ok(withCaption.height - lifelineBottom(withCaption.body) >= 32);
  assert.ok(withoutCaption.height - lifelineBottom(withoutCaption.body) < 32);
});

test("空图不抛错（画布为正，片段为空）", () => {
  const layout = renderSequenceDiagram(spec([], []), OPTIONS);
  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
  assert.equal(layout.body, "");
});
