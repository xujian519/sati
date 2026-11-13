/**
 * tests/patent/figuregen/panel-sheet — 多面板附图拼版渲染器测试。
 *
 * 断言的是**语义事实**而不是快照字节：
 * - 面板数 = 格数（多面板附图必须是"一幅图若干格"，不是"若干幅图"）；
 * - 网格形状按 ⌈√n⌉ / ⌈n/列数⌉ 的规则（2 格 1×2、3 格 2 列、4 格 2×2）；
 * - 各面板共享同一套附图标记系列（同号在两格都出现，且都带 data-ref）；
 * - 有 ref 而 label 无标号时图面补 `(ref)`，且**只补一次**（重复标注会撑破盒宽）；
 * - 缩放系数 ≤ 1（格内图形不被放大，字高才与纸面口径一致）；
 * - 文本经 XML 转义（label 里的 `<`/`&` 不产生裸标签）；
 * - 黑白不变式：只有 #000000/#FFFFFF，无灰度/彩色/渐变/外部引用。
 *
 * 另附线宽下限（≥ 1.5，缩放不改变线宽）与确定性（同 spec 逐字节相同）两条合规断言。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { defaultDirection, layoutFigure, type FigureLayout } from "../../../src/patent/figuregen/layout.js";
import { withVisibleNumeral } from "../../../src/patent/figuregen/numeral-assign.js";
import { renderPanelSheet } from "../../../src/patent/figuregen/panel-sheet.js";
import type { FigurePanel, FigureSpec } from "../../../src/patent/figuregen/types.js";

/** 主字号与边标签字号（px）：与内置渲染器缺省同源（14 / 12）。 */
const FONT = 14;
const EDGE_FONT = 12;

/** 计数（正则需全局标志）。 */
function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** 构造一个只承载面板的附图描述（顶层 nodes/edges 在面板模式下被忽略）。 */
function specOf(panels: FigurePanel[], overrides: Partial<FigureSpec> = {}): FigureSpec {
  return { figure_no: 1, kind: "flowchart", nodes: [], edges: [], panels, ...overrides };
}

/** n 个单节点面板（网格形状用例）。 */
function panelsOf(n: number): FigurePanel[] {
  return Array.from({ length: n }, (_unused, i) => ({
    nodes: [{ id: `n${String(i)}`, label: `步骤${String(i)}` }],
    edges: [],
  }));
}

/** 面板在自身坐标系下的自然布局（与渲染器同口径：先归一标号，再布局）。 */
function naturalLayout(spec: FigureSpec, index: number): FigureLayout {
  const panel = spec.panels?.[index];
  assert.ok(panel !== undefined, "面板不存在");
  const nodes = panel.nodes.map(node =>
    node.ref === undefined ? node : { ...node, label: withVisibleNumeral(node.label, node.ref) },
  );
  return layoutFigure(
    {
      figure_no: spec.figure_no,
      kind: spec.kind,
      direction: panel.direction ?? spec.direction ?? defaultDirection(spec.kind),
      nodes,
      edges: panel.edges,
    },
    { caption: false, fontSizePx: FONT },
  );
}

/** 从产物里取某节点分组的矩形（x/y/width/height）。 */
function nodeBox(body: string, groupId: string): { x: number; y: number; width: number; height: number } {
  const matched = new RegExp(
    `<g id="${groupId}"[^>]*><rect x="(-?[\\d.]+)" y="(-?[\\d.]+)" width="(-?[\\d.]+)" height="(-?[\\d.]+)"`,
    "u",
  ).exec(body);
  assert.ok(matched !== null, `产物里找不到节点分组 ${groupId}`);
  return {
    x: Number(matched[1]),
    y: Number(matched[2]),
    width: Number(matched[3]),
    height: Number(matched[4]),
  };
}

test('① 面板数 = 格数：每个面板一个 <g class="panel"> 与一个格框', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const out = renderPanelSheet(specOf(panelsOf(n)), { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
    assert.equal(countMatches(out.body, /<g class="panel"/gu), n, `${String(n)} 面板的面板分组数不对`);
    assert.equal(countMatches(out.body, /<rect[^>]*fill="none"/gu), n, `${String(n)} 面板的格框数不对`);
  }
});

test("② 网格形状：1 格 1×1、2 格 1×2、3 格 2 列、4 格 2×2、一般规则 ⌈√n⌉", () => {
  const shape = (n: number) =>
    renderPanelSheet(specOf(panelsOf(n)), { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT }).grid;
  assert.deepEqual(shape(1), { columns: 1, rows: 1 });
  assert.deepEqual(shape(2), { columns: 2, rows: 1 });
  assert.deepEqual(shape(3), { columns: 2, rows: 2 });
  assert.deepEqual(shape(4), { columns: 2, rows: 2 });
  assert.deepEqual(shape(5), { columns: 3, rows: 2 });
  assert.deepEqual(shape(6), { columns: 3, rows: 2 });
  assert.deepEqual(shape(7), { columns: 3, rows: 3 });
  assert.deepEqual(shape(9), { columns: 3, rows: 3 });
});

test("③ 共享附图标记系列：各面板节点的 data-ref 都出现在产物里", () => {
  const spec = specOf([
    { title: "图 1A", nodes: [{ id: "a1", label: "电机", ref: 10 }], edges: [] },
    {
      title: "图 1B",
      nodes: [
        { id: "b1", label: "电机", ref: 10 },
        { id: "b2", label: "减速器", ref: 20 },
      ],
      edges: [],
    },
  ]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  // 同一个号在两个面板各出现一次（同一部件在 FIG.1A 与 FIG.1B 里是同一个号）
  assert.equal(countMatches(out.body, /data-ref="10"/gu), 2);
  assert.equal(countMatches(out.body, /data-ref="20"/gu), 1);
  // 原始节点 id 始终可回读（面板内 id 唯一化不丢原值）
  assert.equal(countMatches(out.body, /data-node-id="b2"/gu), 1);
});

test("④ ref 有值而 label 无标号时，图面出现 (ref) 且只出现一次", () => {
  const spec = specOf([{ nodes: [{ id: "a1", label: "混料器", ref: 20 }], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.ok(out.body.includes("(20)"), "图面应补出可见标号 (20)");
  assert.equal(countMatches(out.body, /\(20\)/gu), 1, "标号不应重复标注");
});

test("④b label 已带标号时不重复补画", () => {
  const spec = specOf([{ nodes: [{ id: "a1", label: "混料器(20)", ref: 20 }], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.equal(countMatches(out.body, /\(20\)/gu), 1);
});

test("⑤ 缩放系数 ≤ 1：格内图形不放大（自然尺寸不小于渲染尺寸）", () => {
  const spec = specOf([{ nodes: [{ id: "a1", label: "电机" }], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  const natural = naturalLayout(spec, 0).nodes[0];
  assert.ok(natural !== undefined);
  const rendered = nodeBox(out.body, "n-a1");
  assert.ok(rendered.width <= natural.width + 1e-6, "渲染宽度不得大于自然宽度");
  assert.ok(rendered.height <= natural.height + 1e-6, "渲染高度不得大于自然高度");
});

test("⑤b 内容不大于格内可用区时不缩小（单面板按原尺寸落格）", () => {
  const spec = specOf([{ nodes: [{ id: "a1", label: "电机" }], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  const natural = naturalLayout(spec, 0).nodes[0];
  assert.ok(natural !== undefined);
  const rendered = nodeBox(out.body, "n-a1");
  assert.equal(rendered.width, natural.width);
  assert.equal(rendered.height, natural.height);
});

test("⑤c 内容超过格内可用区时按比例缩小（缩放不是死代码）", () => {
  const nodes = Array.from({ length: 30 }, (_unused, i) => ({
    id: `s${String(i)}`,
    label: `步骤${String(i)}`,
  }));
  const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id }));
  const spec = specOf([{ nodes, edges }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  const natural = naturalLayout(spec, 0).nodes[0];
  assert.ok(natural !== undefined);
  const rendered = nodeBox(out.body, "n-s0");
  assert.ok(rendered.height < natural.height, "超出可用区的内容应被缩小");
  assert.ok(rendered.height <= natural.height + 1e-6, "缩小后不得反向放大");
});

test("⑥ label 含 < 与 & 时不产生裸标签", () => {
  const spec = specOf([{ nodes: [{ id: "x1", label: "A<B & C" }], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.ok(out.body.includes("A&lt;B &amp; C"), "文本应经 XML 转义");
  assert.ok(!out.body.includes("A<B"), "产物不得出现裸标签");
});

test("⑥b 面板标题同样经 XML 转义", () => {
  const spec = specOf([{ title: "图 1A <剖面>", nodes: [], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.ok(out.body.includes("图 1A &lt;剖面&gt;"));
  assert.ok(!out.body.includes("<剖面>"));
});

test("⑦ 产物不含彩色/灰度（黑白不变式）", () => {
  const spec = specOf([
    { nodes: [{ id: "a1", label: "电机", ref: 10 }], edges: [{ from: "a1", to: "a2", label: "是" }] },
    { nodes: [{ id: "b1", label: "机座", ref: 20 }], edges: [] },
  ]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  for (const matched of out.body.matchAll(/#[0-9a-fA-F]{3,8}\b/gu)) {
    const color = matched[0].toUpperCase();
    assert.ok(color === "#000000" || color === "#FFFFFF", `出现非黑白颜色 ${color}`);
  }
  assert.ok(!out.body.includes("rgb("), "不得出现 rgb() 颜色函数");
  assert.ok(!/gray/iu.test(out.body), "不得出现灰度");
  assert.ok(!out.body.includes("<image"), "不得出现外部图像引用");
  assert.ok(!out.body.includes("href="), "不得出现外部引用");
});

test("线宽不小于 1.5（缩放不改变线宽）", () => {
  const spec = specOf([
    {
      nodes: [
        { id: "a1", label: "电机" },
        { id: "a2", label: "机座" },
      ],
      edges: [{ from: "a1", to: "a2" }],
    },
  ]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  const widths = [...out.body.matchAll(/stroke-width="([\d.]+)"/gu)].map(m => Number(m[1]));
  assert.ok(widths.length > 0, "产物里应有描边宽度");
  for (const width of widths) {
    assert.ok(width >= 1.5, `线宽 ${String(width)} 低于 1.5`);
  }
});

test("字号由传入值派生（未缩放时等于传入字号，无写死像素值）", () => {
  const spec = specOf([{ nodes: [{ id: "a1", label: "电机" }], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  const sizes = [...out.body.matchAll(/font-size="([\d.]+)"/gu)].map(m => Number(m[1]));
  assert.ok(sizes.length > 0);
  for (const size of sizes) {
    assert.ok(size <= FONT + 1e-6, `字号 ${String(size)} 不得大于传入字号`);
    assert.ok(size > 0);
  }
});

test("没有面板时返回空 body（调用方退回单幅渲染）", () => {
  const withoutPanels = renderPanelSheet(
    { figure_no: 1, kind: "flowchart", nodes: [{ id: "a1", label: "电机" }], edges: [] },
    { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT },
  );
  assert.equal(withoutPanels.body, "");
  assert.equal(withoutPanels.width, 0);
  assert.equal(withoutPanels.height, 0);

  const emptyPanels = renderPanelSheet(specOf([]), { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.equal(emptyPanels.body, "");
  assert.equal(emptyPanels.width, 0);
});

test("面板标题画在格内（标题出现在产物里）", () => {
  const spec = specOf([
    { title: "图 1A", nodes: [{ id: "a1", label: "电机" }], edges: [] },
    { title: "图 1B", nodes: [{ id: "b1", label: "机座" }], edges: [] },
  ]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.ok(out.body.includes("图 1A"));
  assert.ok(out.body.includes("图 1B"));
});

test("空格（无节点的面板）也画格框，不产出悬空图元", () => {
  const spec = specOf([
    { nodes: [{ id: "a1", label: "电机" }], edges: [] },
    { nodes: [], edges: [] },
  ]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.equal(countMatches(out.body, /<g class="panel"/gu), 2);
  assert.equal(countMatches(out.body, /<rect[^>]*fill="none"/gu), 2);
});

test("面板方向覆盖生效（panel.direction 优先于主图方向）", () => {
  const base: FigurePanel = {
    nodes: [
      { id: "a1", label: "电机" },
      { id: "a2", label: "机座" },
    ],
    edges: [{ from: "a1", to: "a2" }],
  };
  const tb = renderPanelSheet(specOf([base]), { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  const lr = renderPanelSheet(specOf([{ ...base, direction: "LR" }]), { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.notEqual(tb.body, lr.body, "面板方向不同，布局应不同");
});

test("产物不含 <svg> 根、defs 与图号（由调用方组装文档）", () => {
  const spec = specOf([{ nodes: [{ id: "a1", label: "电机" }], edges: [] }]);
  const out = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.ok(!out.body.includes("<svg"), "片段不含 svg 根");
  assert.ok(!out.body.includes("<defs"), "片段不含 defs");
  assert.ok(!/图\s*1/gu.test(out.body), "片段不含图号");
  assert.ok(typeof out.defs === "string" && out.defs.includes("marker"), "箭头 marker 走 defs 通道");
});

test("确定性：同一 spec 两次渲染逐字节相同", () => {
  const spec = specOf([
    { nodes: [{ id: "a1", label: "电机", ref: 10 }], edges: [] },
    { nodes: [{ id: "b1", label: "电机", ref: 10 }], edges: [] },
  ]);
  const first = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  const second = renderPanelSheet(spec, { fontSizePx: FONT, edgeFontSizePx: EDGE_FONT });
  assert.equal(first.body, second.body);
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
});
