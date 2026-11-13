/**
 * src/patent/figuregen — 二维剖视（cross-section）渲染器测试。
 *
 * 覆盖：断面轮廓数与零件数对应、剖面线只落在轮廓内（端点在内部）、相邻零件剖面线方向相反、
 * 孔内不画剖面线、no_hatch 零件不剖、附图标记只画一次、文本转义、黑白不变式、
 * 字号取自入参、剖切线是点划线、确定性（GB/T 4457.5 与审查指南一部一章 4.3/4.6 的
 * 构造期不变式）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderCrossSection } from "../../../src/patent/figuregen/cross-section.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

const OPTIONS = { fontSizePx: 14, edgeFontSizePx: 12 };

/** 图面点（px）。 */
type Point = readonly [number, number];

/** 归一化轮廓点（元组类型：不让 TS 把字面量推断成 number[][]）。 */
type NormalizedPoint = readonly [number, number];

/** 断面轮廓（归一化坐标 0..1）。 */
function outline(...points: NormalizedPoint[]): NormalizedPoint[] {
  return points;
}

/** 两个断面零件：左「壳体」（带一个方孔）、右「轴」。 */
const SPEC: FigureSpec = {
  figure_no: 1,
  kind: "cross-section",
  nodes: [],
  edges: [],
  section: {
    parts: [
      {
        id: "housing",
        label: "壳体",
        ref: 10,
        outline: outline([0.05, 0.1], [0.45, 0.1], [0.45, 0.9], [0.05, 0.9]),
        holes: [outline([0.15, 0.35], [0.35, 0.35], [0.35, 0.65], [0.15, 0.65])],
      },
      {
        id: "shaft",
        label: "轴",
        ref: 20,
        outline: outline([0.55, 0.25], [0.95, 0.25], [0.95, 0.75], [0.55, 0.75]),
      },
    ],
    cut: [
      [0.5, 0.05],
      [0.5, 0.95],
    ],
  },
};

/** 同一断面、只有「壳体」且没有孔（用于比较孔对剖面线总量的影响）。 */
const SPEC_WITHOUT_HOLE: FigureSpec = {
  figure_no: 1,
  kind: "cross-section",
  nodes: [],
  edges: [],
  section: {
    parts: [
      {
        id: "housing",
        label: "壳体",
        ref: 10,
        outline: outline([0.05, 0.1], [0.45, 0.1], [0.45, 0.9], [0.05, 0.9]),
      },
    ],
  },
};

/** 带 no_hatch 零件的断面。 */
const SPEC_NO_HATCH: FigureSpec = {
  figure_no: 1,
  kind: "cross-section",
  nodes: [],
  edges: [],
  section: {
    parts: [
      {
        id: "cover",
        label: "盖板",
        outline: outline([0.1, 0.1], [0.9, 0.1], [0.9, 0.4], [0.1, 0.4]),
        no_hatch: true,
      },
    ],
  },
};

/** 一个零件在图面上的全部图元（按 `<g>` 分组回读）。 */
type PartBlock = {
  /** 分组 id（`n-<partId>`）。 */
  id: string;
  /** 多边形：第一个是断面轮廓，其余是孔。 */
  polygons: Point[][];
  /** 该零件的剖面线段。 */
  hatch: { from: Point; to: Point }[];
  /** 该零件的图面文字。 */
  texts: { x: number; y: number; content: string }[];
};

/** 属性取值（数值）。 */
function numberAttr(attributes: string, name: string): number {
  return Number(new RegExp(`${name}="([^"]*)"`, "u").exec(attributes)?.[1] ?? Number.NaN);
}

/** 回读图面：按零件分组取出轮廓、剖面线与文字。 */
function partsOf(body: string): PartBlock[] {
  const blocks: PartBlock[] = [];
  for (const match of body.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/gu)) {
    const content = match[2] ?? "";
    const polygons: Point[][] = [];
    for (const polygon of content.matchAll(/<polygon\b([^>]*)\/>/gu)) {
      const raw = /points="([^"]*)"/u.exec(polygon[1] ?? "")?.[1] ?? "";
      polygons.push(
        raw
          .split(" ")
          .filter(part => part.length > 0)
          .map(part => {
            const [x, y] = part.split(",");
            return [Number(x), Number(y)] as const;
          }),
      );
    }
    const hatch: { from: Point; to: Point }[] = [];
    for (const line of content.matchAll(/<line\b([^>]*)\/>/gu)) {
      const attributes = line[1] ?? "";
      if (!attributes.includes('data-dsh-role="hatch"')) continue;
      hatch.push({
        from: [numberAttr(attributes, "x1"), numberAttr(attributes, "y1")],
        to: [numberAttr(attributes, "x2"), numberAttr(attributes, "y2")],
      });
    }
    const texts = [...content.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gu)].map(text => ({
      x: numberAttr(text[1] ?? "", "x"),
      y: numberAttr(text[1] ?? "", "y"),
      content: text[2] ?? "",
    }));
    blocks.push({ id: /id="([^"]*)"/u.exec(match[1] ?? "")?.[1] ?? "", polygons, hatch, texts });
  }
  return blocks;
}

/** 取指定角色的 `<line>`（剖切线）。 */
function linesOf(body: string, role: string): { from: Point; to: Point }[] {
  const lines: { from: Point; to: Point }[] = [];
  for (const match of body.matchAll(/<line\b([^>]*)\/>/gu)) {
    const attributes = match[1] ?? "";
    if (!attributes.includes(`data-dsh-role="${role}"`)) continue;
    lines.push({
      from: [numberAttr(attributes, "x1"), numberAttr(attributes, "y1")],
      to: [numberAttr(attributes, "x2"), numberAttr(attributes, "y2")],
    });
  }
  return lines;
}

/** 取图面文字（已转义的原文）。 */
function textsOf(body: string): string[] {
  return [...body.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gu)].map(match => match[1] ?? "");
}

/** 点是否在多边形内部（边界算外部）。 */
function inside(point: Point, polygon: readonly Point[]): boolean {
  let result = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index] as Point;
    const to = polygon[(index + 1) % polygon.length] as Point;
    if (from[1] > point[1] !== to[1] > point[1]) {
      const crossing = from[0] + ((point[1] - from[1]) * (to[0] - from[0])) / (to[1] - from[1]);
      if (crossing > point[0]) result = !result;
    }
  }
  return result;
}

/** 线段总长（px）。 */
function totalLength(lines: readonly { from: Point; to: Point }[]): number {
  return lines.reduce((sum, line) => {
    return sum + Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]);
  }, 0);
}

/** 线段方向（度，落在 [0,180)）。 */
function orientationOf(line: { from: Point; to: Point }): number {
  const degrees = (Math.atan2(line.to[1] - line.from[1], line.to[0] - line.from[0]) * 180) / Math.PI;
  return ((degrees % 180) + 180) % 180;
}

test("断面轮廓数 = 零件数（孔另计，不冒充轮廓）", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  const parts = partsOf(layout.body);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.id, "n-housing");
  assert.equal(parts[1]?.id, "n-shaft");
  // 壳体 = 轮廓 + 1 个孔；轴 = 只有轮廓。
  assert.equal(parts[0]?.polygons.length, 2);
  assert.equal(parts[1]?.polygons.length, 1);
  // 轮廓多边形都带分组属性（同一零件的轮廓与孔同组）。
  const grouped = layout.body.match(/<polygon[^>]*data-dsh-hatch-group="0"/gu) ?? [];
  assert.equal(grouped.length, 2);
});

test("每个零件的剖面线端点都落在自己的轮廓内部", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  const parts = partsOf(layout.body);
  let total = 0;
  for (const part of parts) {
    const outlinePolygon = part.polygons[0] ?? [];
    assert.ok(part.hatch.length > 0, `零件 ${part.id} 应有剖面线`);
    total += part.hatch.length;
    for (const line of part.hatch) {
      assert.ok(inside(line.from, outlinePolygon), `剖面线起点 ${line.from.join(",")} 不在轮廓内`);
      assert.ok(inside(line.to, outlinePolygon), `剖面线终点 ${line.to.join(",")} 不在轮廓内`);
    }
  }
  assert.ok(total > 0, "至少要画出一条剖面线");
});

test("相邻零件的剖面线方向相反（45° / 135° 交替）", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  assert.deepEqual([...(layout.hatchAnglesDeg ?? [])], [45, 135]);
  const parts = partsOf(layout.body);
  const first = parts[0]?.hatch ?? [];
  const second = parts[1]?.hatch ?? [];
  assert.ok(first.length > 0);
  assert.ok(second.length > 0);
  assert.equal(Math.round(orientationOf(first[0] as { from: Point; to: Point })), 45);
  assert.equal(Math.round(orientationOf(second[0] as { from: Point; to: Point })), 135);
});

test("孔内不画剖面线（有孔的零件剖面线总长更短）", () => {
  const withHole = partsOf(renderCrossSection(SPEC, OPTIONS).body)[0];
  const withoutHole = partsOf(renderCrossSection(SPEC_WITHOUT_HOLE, OPTIONS).body)[0];
  assert.ok(withHole && withoutHole);
  const holeLines = withHole?.hatch ?? [];
  const plainLines = withoutHole?.hatch ?? [];
  assert.ok(totalLength(holeLines) < totalLength(plainLines), "孔应当从剖面线里挖掉一段");

  // 孔内不得有任何剖面线段经过：沿线取样点必须都不在孔内。
  const hole = withHole?.polygons[1] ?? [];
  assert.ok(hole.length >= 3);
  for (const line of holeLines) {
    for (let step = 0; step <= 10; step += 1) {
      const ratio = step / 10;
      const sample: Point = [
        line.from[0] + (line.to[0] - line.from[0]) * ratio,
        line.from[1] + (line.to[1] - line.from[1]) * ratio,
      ];
      assert.ok(!inside(sample, hole), `剖面线穿过了孔：${sample.join(",")}`);
    }
  }
});

test("no_hatch 的零件只画轮廓、不画剖面线", () => {
  const layout = renderCrossSection(SPEC_NO_HATCH, OPTIONS);
  assert.equal(linesOf(layout.body, "hatch").length, 0);
  const parts = partsOf(layout.body);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.polygons.length, 1);
  assert.ok(textsOf(layout.body).some(text => text.includes("盖板")));
});

test("附图标记只画一次（label 缺标记时补画，已带则不重复）", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  assert.ok(layout.body.includes("壳体(10)"));
  assert.ok(layout.body.includes("轴(20)"));
  assert.equal(layout.body.split("(10)").length - 1, 1);
  assert.equal(layout.body.split("(20)").length - 1, 1);

  const marked: FigureSpec = {
    figure_no: 1,
    kind: "cross-section",
    nodes: [],
    edges: [],
    section: {
      parts: [
        {
          id: "housing",
          label: "壳体(10)",
          ref: 10,
          outline: outline([0.05, 0.1], [0.45, 0.1], [0.45, 0.9], [0.05, 0.9]),
        },
      ],
    },
  };
  const markedLayout = renderCrossSection(marked, OPTIONS);
  assert.equal(markedLayout.body.split("(10)").length - 1, 1);
});

test("label 里的 < 与 & 被转义（不产生裸标签）", () => {
  const escaped: FigureSpec = {
    figure_no: 1,
    kind: "cross-section",
    nodes: [],
    edges: [],
    section: {
      parts: [
        {
          id: "housing",
          label: "A<B&C",
          outline: outline([0.05, 0.1], [0.45, 0.1], [0.45, 0.9], [0.05, 0.9]),
        },
      ],
    },
  };
  const layout = renderCrossSection(escaped, OPTIONS);
  assert.ok(layout.body.includes("A&lt;B&amp;C"));
  assert.ok(!layout.body.includes("A<B"), "不得出现未转义的 '<'");
  assert.ok(!layout.body.includes("&C<"), "不得出现未转义的 '&'");
  // 文本节点里不得混入裸尖括号（标签注入）。
  for (const text of textsOf(layout.body)) {
    assert.ok(!text.includes("<"));
    assert.ok(!text.includes(">"));
  }
});

test("黑白不变式：只有 #000000 / #FFFFFF，无彩色与灰度", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  const colors = [...layout.body.matchAll(/#[0-9A-Fa-f]{3,8}/gu)].map(match => match[0].toUpperCase());
  assert.ok(colors.length > 0);
  for (const color of colors) {
    assert.ok(color === "#000000" || color === "#FFFFFF", `出现非法颜色 ${color}`);
  }
  assert.ok(!layout.body.includes("#8"));
  assert.ok(!layout.body.includes("#c"));
  assert.ok(!layout.body.includes("rgb("));
  assert.ok(!layout.body.includes("gray"));
  assert.ok(!layout.body.includes("<image"));
  assert.ok(!layout.body.includes("http://"));
  assert.ok(!layout.body.includes("https://"));
});

test("字号取自入参（不写死像素值）", () => {
  const layout = renderCrossSection(SPEC, { fontSizePx: 20, edgeFontSizePx: 16 });
  assert.ok(layout.body.includes('font-size="20"'));
  assert.ok(!layout.body.includes('font-size="14"'));
  const plain = renderCrossSection(SPEC, OPTIONS);
  assert.ok(plain.body.includes('font-size="14"'));
  assert.ok(!plain.body.includes('font-size="20"'));
});

test("剖切线画成点划线；不给 cut 时不画", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  const cut = linesOf(layout.body, "cut");
  assert.equal(cut.length, 1);
  assert.ok(layout.body.includes('stroke-dasharray="12 4 3 4"'));
  const withoutCut: FigureSpec = {
    figure_no: 1,
    kind: "cross-section",
    nodes: [],
    edges: [],
    section: { parts: SPEC.section?.parts ?? [] },
  };
  assert.equal(linesOf(renderCrossSection(withoutCut, OPTIONS).body, "cut").length, 0);
});

test("零件名画在自己轮廓的外侧（不压住剖面线）", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  for (const part of partsOf(layout.body)) {
    const outlinePolygon = part.polygons[0] ?? [];
    const top = Math.min(...outlinePolygon.map(point => point[1]));
    const right = Math.max(...outlinePolygon.map(point => point[0]));
    for (const text of part.texts) {
      const outside = text.y < top || text.x > right;
      assert.ok(outside, `零件名「${text.content}」压在轮廓内部（y=${text.y} x=${text.x}）`);
    }
  }
});

test("底部预留图号标注带（图号不会压住断面）", () => {
  const layout = renderCrossSection(SPEC, OPTIONS);
  let lowest = 0;
  for (const part of partsOf(layout.body)) {
    for (const polygon of part.polygons) {
      for (const point of polygon) lowest = Math.max(lowest, point[1]);
    }
  }
  // 图号由调用方画在画布底缘（height-16 附近的基线），内容底缘须离底够远。
  assert.ok(layout.height - lowest >= 30, `内容底缘离画布底只有 ${String(layout.height - lowest)}px，图号会压住断面`);
});

test("入参非法当场报错：顶点不足 / 坐标越界", () => {
  const tooFew: FigureSpec = {
    figure_no: 1,
    kind: "cross-section",
    nodes: [],
    edges: [],
    section: { parts: [{ id: "p", outline: outline([0, 0], [1, 1]) }] },
  };
  assert.throws(() => renderCrossSection(tooFew, OPTIONS), /轮廓至少要 3 个顶点/u);

  const outOfRange: FigureSpec = {
    figure_no: 1,
    kind: "cross-section",
    nodes: [],
    edges: [],
    section: { parts: [{ id: "p", outline: outline([0, 0], [1.5, 1], [0.2, 0.3]) }] },
  };
  assert.throws(() => renderCrossSection(outOfRange, OPTIONS), /归一化域 0\.\.1/u);
});

test("确定性：同样输入两次产出逐字相同", () => {
  const first = renderCrossSection(SPEC, OPTIONS);
  const second = renderCrossSection(SPEC, OPTIONS);
  assert.equal(first.body, second.body);
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
  assert.deepEqual([...(first.hatchAnglesDeg ?? [])], [...(second.hatchAnglesDeg ?? [])]);
});
