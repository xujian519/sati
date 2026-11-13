/**
 * src/patent/figuregen — 电路图（kind="circuit"）矢量渲染器。
 *
 * 画法口径：IEC 矩形符号（电阻=空心矩形、电容=两条极板线、电感=三段方波、
 * 二极管=三角+竖直阴极条、电源=圆圈+极性记号、接地=竖线+三条递减横线、
 * 开关=两触点+断开的斜臂、灯泡=圆内叉、电池=长短极板对）。
 *
 * 为什么自带布局（**不复用 layout.ts 的 layoutFigure**）：流程图的节点是**文字盒**
 * （盒宽随 label 长度算），电路图的节点是**元件符号**（尺寸固定；label 是符号
 * 下方的名称，不是符号本体）。拿文字盒的盒宽去画元件，会得到"矩形被文字撑大"的
 * 可疑图形——元件符号的尺寸必须由符号本身决定。故本模块自带一套拓扑分层 + 定位。
 *
 * 合规（审查指南一部一章 4.3/4.6）：描边与文字一律 #000000；填充只有 "none" 与
 * #FFFFFF；无渐变/阴影/外部引用（不出现 `<image>`）；线宽 ≥ 1.5；字号一律来自入参
 * （不写死像素值——V7 字高判据按法域档案核验，写死即与档案脱钩）；坐标一律 fmt、
 * 文本一律 escapeXml。
 *
 * 输出是 **SVG 片段**（不含 `<svg>` 根、不含 defs、不含图号），由调用方拼装成完整
 * 文档——与 `chart.ts` 的 `renderChartBody` 同一约定。
 */

import { measureTextWidth } from "./metrics.js";
import { withVisibleNumeral } from "./numeral-assign.js";
import { escapeXml, fmt } from "./render-utils.js";
import type { FigureEdge, FigureNode, FigureNodeShape, FigureSpec } from "./types.js";

/** 主流向：h=自左向右（LR，电路图缺省），v=自上向下（TB）。 */
type Axis = "h" | "v";

type Point = { x: number; y: number };

/** 电路元件形状全集（能画专用符号的形状）。 */
const CIRCUIT_SHAPES = [
  "resistor",
  "capacitor",
  "inductor",
  "diode",
  "source",
  "ground",
  "switch",
  "lamp",
  "battery",
] as const;

type CircuitShape = (typeof CIRCUIT_SHAPES)[number];

/** 是否电路元件形状（能画专用符号）。 */
function isCircuitShape(shape: FigureNodeShape): shape is CircuitShape {
  return (CIRCUIT_SHAPES as readonly string[]).includes(shape);
}

/** 画幅留白（px）：图形四周的空白，包围盒平移后仍留这一圈。 */
const MARGIN = 28;
/** 相邻层（主流向）之间的净距（px）：层内元件端子之间留给连线。 */
const LAYER_GAP = 56;
/** 同层内相邻元件（垂主流向）之间的净距（px）。 */
const SIB_GAP = 28;
/** 元件端子到元件中心的距离（px）：符号框尺寸固定 ⇒ 端子位置固定。 */
const TERMINAL_U = 28;
/** 装置框（未知形状）的引线长度（px）。 */
const BOX_LEAD = 12;
/** 文字与图线的净距（px）：审查复核的「标号净距」判据按 1.5 毫米核验。 */
const LABEL_GAP = 8;
/** 同一对节点的多条连线之间的平行偏移步距（px）。 */
const PARALLEL_STEP = 8;
/** 描边与文字颜色（黑白不变式：只有这两种颜色）。 */
const INK = "#000000";

/**
 * 元件符号的局部几何：`(u 沿主流向, v 垂主流向)`，原点在符号中心。
 *
 * `uMin/uMax/vMin/vMax` 是**本体**的边界（决定包围盒与元件名的落点），
 * `backU/frontU` 是**引线在符号上的接点**——两者对多数符号相同，但对接地符号不同
 * （接地本体的横线比引线接点宽）。
 */
type SymbolGeometry = {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
  readonly backU: number;
  readonly frontU: number;
  /** 是否有前侧引线（接地符号只有一个端子）。 */
  readonly forwardLead: boolean;
};

const SYMBOL_GEOMETRY: Readonly<Record<CircuitShape, SymbolGeometry>> = {
  resistor: { uMin: -16, uMax: 16, vMin: -9, vMax: 9, backU: -16, frontU: 16, forwardLead: true },
  capacitor: { uMin: -5, uMax: 5, vMin: -11, vMax: 11, backU: -5, frontU: 5, forwardLead: true },
  inductor: { uMin: -18, uMax: 18, vMin: -8, vMax: 8, backU: -18, frontU: 18, forwardLead: true },
  diode: { uMin: -10, uMax: 10, vMin: -11, vMax: 11, backU: -10, frontU: 10, forwardLead: true },
  source: { uMin: -13, uMax: 13, vMin: -13, vMax: 13, backU: -13, frontU: 13, forwardLead: true },
  ground: { uMin: -10, uMax: 10, vMin: 0, vMax: 19, backU: 0, frontU: 0, forwardLead: false },
  switch: { uMin: -10, uMax: 10, vMin: 0, vMax: 9, backU: -10, frontU: 10, forwardLead: true },
  lamp: { uMin: -13, uMax: 13, vMin: -13, vMax: 13, backU: -13, frontU: 13, forwardLead: true },
  battery: { uMin: -4, uMax: 4, vMin: -12, vMax: 12, backU: -4, frontU: 4, forwardLead: true },
};

/**
 * 接地符号**按屏幕方向绘制**（始终朝下），故几何随流向不同：
 * LR 时竖线是垂流向的、TB 时竖线是主流向的。
 */
function groundGeometry(axis: Axis): SymbolGeometry {
  return axis === "h"
    ? { uMin: -10, uMax: 10, vMin: 0, vMax: 19, backU: 0, frontU: 0, forwardLead: false }
    : { uMin: 0, uMax: 19, vMin: -10, vMax: 10, backU: 0, frontU: 0, forwardLead: false };
}

function geometryFor(shape: CircuitShape, axis: Axis): SymbolGeometry {
  return shape === "ground" ? groundGeometry(axis) : SYMBOL_GEOMETRY[shape];
}

/** 图元（先存几何、算出包围盒，再统一平移进画幅——故坐标不在生成时写死）。 */
type Primitive =
  | {
      readonly kind: "line";
      readonly from: Point;
      readonly to: Point;
      readonly dashed: boolean;
      readonly role?: string;
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx?: number;
    }
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number }
  | { readonly kind: "polygon"; readonly points: readonly Point[] }
  | { readonly kind: "polyline"; readonly points: readonly Point[] }
  | {
      readonly kind: "text";
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly anchor: "start" | "middle" | "end";
      readonly content: string;
    };

/** 元件（组件）模型：一个节点 → 一个可绘制的电路元件。 */
type Component = {
  readonly node: FigureNode;
  /** 生效形状（未指定时按 rect 处理）。 */
  readonly shape: FigureNodeShape;
  /** 专用符号形状；undefined = 按普通矩形框（装置框）处理。 */
  readonly symbol: CircuitShape | undefined;
  /** 主流向坐标（沿流向的中心）。 */
  u: number;
  /** 垂主流向坐标。 */
  v: number;
  /** 端子到中心的沿流向距离。 */
  uHalf: number;
  /** 可见元件名（label + 归一后的附图标记），按行拆分。 */
  readonly lines: readonly string[];
  /** 文字宽（px，取最宽一行）。 */
  readonly textWidth: number;
  /** 文字是否画在符号内部（装置框）。 */
  readonly inside: boolean;
  /** 符号几何（装置框按其矩形给出）。 */
  readonly geometry: SymbolGeometry;
};

/** 电路图布局结果。 */
export type CircuitDiagramLayout = {
  /** SVG 片段（不含 `<svg>` 根、不含 defs、不含图号）。 */
  body: string;
  width: number;
  height: number;
  defs?: string;
  /** 未能识别为电路元件的形状（调用方据此在报告里点名，不静默当作矩形）。 */
  unknownShapes?: readonly string[];
};

/** 节点 id → 合法 XML id 片段（与 render-svg.ts 同口径）。 */
function xmlId(nodeId: string): string {
  return nodeId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
}

/** 附图标记归一后的可见元件名（`withVisibleNumeral` 已含"只画一次"判据）。 */
function visibleLines(node: FigureNode): string[] {
  const label = node.ref === undefined ? node.label : withVisibleNumeral(node.label, node.ref);
  return label.split("\\n");
}

/** 构造元件：符号类尺寸固定，装置框（未知形状）尺寸随文字走。 */
function makeComponent(node: FigureNode, fontSizePx: number, axis: Axis, unknownShapes: Set<string>): Component {
  const shape: FigureNodeShape = node.shape ?? "rect";
  const symbol = isCircuitShape(shape) ? shape : undefined;
  if (symbol === undefined) unknownShapes.add(shape);
  const lines = visibleLines(node);
  const textWidth = Math.max(0, ...lines.map(line => measureTextWidth(line, fontSizePx)));
  if (symbol !== undefined) {
    return {
      node,
      shape,
      symbol,
      u: 0,
      v: 0,
      uHalf: TERMINAL_U,
      lines,
      textWidth,
      inside: false,
      geometry: geometryFor(symbol, axis),
    };
  }
  // 装置框：它是框不是符号，尺寸随文字走；文字画在框内。
  const halfAlong = Math.max(36, (textWidth + 32) / 2);
  const halfCross = Math.max(20, (fontSizePx + 16) / 2);
  return {
    node,
    shape,
    symbol: undefined,
    u: 0,
    v: 0,
    uHalf: halfAlong + BOX_LEAD,
    lines,
    textWidth,
    inside: true,
    geometry: {
      uMin: -halfAlong,
      uMax: halfAlong,
      vMin: -halfCross,
      vMax: halfCross,
      backU: -halfAlong,
      frontU: halfAlong,
      forwardLead: true,
    },
  };
}

/**
 * 拓扑分层（BFS）：入度 0 为首层，沿边向外推一层。
 *
 * 回边（成环）不参与分层：环上的节点在 BFS 结束后统一放到最后一层，
 * 保证不死循环、也不丢失节点（丢节点＝图面缺元件，比排得难看严重得多）。
 */
function assignLayers(nodes: readonly FigureNode[], edges: readonly FigureEdge[]): Map<string, number> {
  const ids = new Set(nodes.map(node => node.id));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      level.set(node.id, 0);
      queue.push(node.id);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head] as string;
    const current = level.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      if (level.has(next)) continue;
      level.set(next, current + 1);
      queue.push(next);
    }
  }
  const maxLevel = Math.max(-1, ...level.values());
  for (const node of nodes) {
    if (!level.has(node.id)) level.set(node.id, maxLevel + 1);
  }
  return level;
}

/** 局部坐标 → 画布坐标的映射器。 */
type Painter = {
  at: (u: number, v: number) => Point;
};

function makePainter(axis: Axis, center: Point): Painter {
  return {
    at: (u, v) => (axis === "h" ? { x: center.x + u, y: center.y + v } : { x: center.x + v, y: center.y + u }),
  };
}

function pushLine(sink: Primitive[], painter: Painter, u1: number, v1: number, u2: number, v2: number): void {
  sink.push({ kind: "line", from: painter.at(u1, v1), to: painter.at(u2, v2), dashed: false });
}

/** 矩形（取两角，按画布坐标归一）。 */
function pushRect(
  sink: Primitive[],
  painter: Painter,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
  rx?: number,
): void {
  const a = painter.at(u1, v1);
  const b = painter.at(u2, v2);
  sink.push({
    kind: "rect",
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
    ...(rx === undefined ? {} : { rx }),
  });
}

function pushCircle(sink: Primitive[], painter: Painter, u: number, v: number, r: number): void {
  const center = painter.at(u, v);
  sink.push({ kind: "circle", cx: center.x, cy: center.y, r });
}

/** 画一个电路元件符号（含引线）。 */
function paintSymbol(
  symbol: CircuitShape,
  axis: Axis,
  sink: Primitive[],
  painter: Painter,
  geometry: SymbolGeometry,
): void {
  // 引线：自符号本体边界伸到固定端子（符号框尺寸固定 ⇒ 端子位置固定）。
  pushLine(sink, painter, -TERMINAL_U, 0, geometry.backU, 0);
  if (geometry.forwardLead) pushLine(sink, painter, geometry.frontU, 0, TERMINAL_U, 0);

  switch (symbol) {
    case "resistor": {
      // 空心矩形（长边沿流向 ⇒ LR 视图下宽>高）。
      pushRect(sink, painter, geometry.uMin, geometry.vMin, geometry.uMax, geometry.vMax);
      break;
    }
    case "capacitor": {
      // 两条垂直于流向的极板线（LR 视图下即两条竖直短线）。
      pushLine(sink, painter, geometry.uMin, geometry.vMin, geometry.uMin, geometry.vMax);
      pushLine(sink, painter, geometry.uMax, geometry.vMin, geometry.uMax, geometry.vMax);
      break;
    }
    case "inductor": {
      // 三段方波（IEC 矩形口径，不用半圆）：自引线向下 → 横向 → 向上 → 横向 → 向下 → 横向 → 回到引线。
      sink.push({
        kind: "polyline",
        points: [
          painter.at(-18, 0),
          painter.at(-18, -8),
          painter.at(-6, -8),
          painter.at(-6, 8),
          painter.at(6, 8),
          painter.at(6, -8),
          painter.at(18, -8),
          painter.at(18, 0),
        ],
      });
      break;
    }
    case "diode": {
      // 阳极三角 + 阴极竖条（三角尖端抵住竖条）。
      sink.push({
        kind: "polygon",
        points: [painter.at(-10, -9), painter.at(-10, 9), painter.at(10, 0)],
      });
      pushLine(sink, painter, geometry.uMax, geometry.vMin, geometry.uMax, geometry.vMax);
      break;
    }
    case "source": {
      // 圆圈 + 极性记号（+ 与 −）。
      pushCircle(sink, painter, 0, 0, 13);
      pushLine(sink, painter, -11, 0, -1, 0);
      pushLine(sink, painter, -6, -5, -6, 5);
      pushLine(sink, painter, 2, 0, 12, 0);
      break;
    }
    case "ground": {
      // 竖线 + 三条递减横线（始终朝下，不随流向旋转）。
      if (axis === "h") {
        pushLine(sink, painter, 0, 0, 0, 10);
        pushLine(sink, painter, -10, 10, 10, 10);
        pushLine(sink, painter, -6.5, 15, 6.5, 15);
        pushLine(sink, painter, -3, 19, 3, 19);
      } else {
        pushLine(sink, painter, 0, 0, 10, 0);
        pushLine(sink, painter, 10, -10, 10, 10);
        pushLine(sink, painter, 15, -6.5, 15, 6.5);
        pushLine(sink, painter, 19, -3, 19, 3);
      }
      break;
    }
    case "switch": {
      // 两个触点 + 一段断开的斜臂（斜臂不与右触点相接＝断开）。
      pushCircle(sink, painter, -10, 0, 2.5);
      pushCircle(sink, painter, 10, 0, 2.5);
      pushLine(sink, painter, -10, 0, 7, 8);
      break;
    }
    case "lamp": {
      // 圆 + 内部叉。
      pushCircle(sink, painter, 0, 0, 13);
      pushLine(sink, painter, -9.2, -9.2, 9.2, 9.2);
      pushLine(sink, painter, -9.2, 9.2, 9.2, -9.2);
      break;
    }
    case "battery": {
      // 长短极板对（长板为正、短板为负）。
      pushLine(sink, painter, geometry.uMin, geometry.vMin, geometry.uMin, geometry.vMax);
      pushLine(sink, painter, geometry.uMax, -7, geometry.uMax, 7);
      break;
    }
  }
}

/** 元件名占用的垂流向长度：LR 为一个行高（元件名在符号下方），TB 为文字宽（元件名在符号右方）。 */
function labelExtent(comp: Component, axis: Axis, fontSizePx: number): number {
  if (comp.inside) return 0;
  return axis === "h" ? fontSizePx : comp.textWidth;
}

/** 画元件名（可见标号已并入元件名，故只画一次）。 */
function paintLabel(sink: Primitive[], comp: Component, axis: Axis, center: Point, fontSizePx: number): void {
  if (comp.lines.length === 0) return;
  const lineHeight = fontSizePx * 1.2;
  if (comp.inside) {
    // 装置框：元件名在框内居中。
    const first = center.y - ((comp.lines.length - 1) * lineHeight) / 2 + fontSizePx * 0.35;
    comp.lines.forEach((content, index) => {
      sink.push({
        kind: "text",
        x: center.x,
        y: first + index * lineHeight,
        size: fontSizePx,
        anchor: "middle",
        content,
      });
    });
    return;
  }
  if (axis === "h") {
    // LR：元件名在符号下方（+v 即屏幕下方）。
    const top = center.y + comp.geometry.vMax + LABEL_GAP;
    comp.lines.forEach((content, index) => {
      sink.push({
        kind: "text",
        x: center.x,
        y: top + fontSizePx * 0.8 + index * lineHeight,
        size: fontSizePx,
        anchor: "middle",
        content,
      });
    });
    return;
  }
  // TB：元件名在符号右方（+v 即屏幕右方），多行时垂直居中。
  const x = center.x + comp.geometry.vMax + LABEL_GAP;
  const first = center.y - ((comp.lines.length - 1) * lineHeight) / 2 + fontSizePx * 0.35;
  comp.lines.forEach((content, index) => {
    sink.push({
      kind: "text",
      x,
      y: first + index * lineHeight,
      size: fontSizePx,
      anchor: "start",
      content,
    });
  });
}

/** 元件中心（画布坐标）。 */
function componentCenter(comp: Component, axis: Axis): Point {
  return axis === "h" ? { x: comp.u, y: comp.v } : { x: comp.v, y: comp.u };
}

/** 端子位置：`sign=+1` 取前侧端子、`sign=-1` 取后侧端子。 */
function terminalPoint(comp: Component, axis: Axis, sign: 1 | -1): Point {
  const center = componentCenter(comp, axis);
  const offset = sign * comp.uHalf;
  return axis === "h" ? { x: center.x + offset, y: center.y } : { x: center.x, y: center.y + offset };
}

/** 同一对节点的多条边：键与顺序无关。 */
function pairKey(from: string, to: string): string {
  return from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}

/**
 * 渲染一幅电路图（SVG 片段）。
 *
 * `spec.nodes` 即元件（`node.shape` 指明元件类型），`spec.edges` 即连线；
 * 方向由 `spec.direction` 决定（缺省 LR，电路图按信号流向自左向右读）。
 * 未列出的形状（如 `rect`）按普通矩形框处理并在 `unknownShapes` 里如实回报。
 */
export function renderCircuitDiagram(
  spec: FigureSpec,
  options: { fontSizePx: number; edgeFontSizePx: number },
): CircuitDiagramLayout {
  const axis: Axis = (spec.direction ?? "LR") === "TB" ? "v" : "h";
  const fontSizePx = options.fontSizePx;
  const edgeFontSize = options.edgeFontSizePx;
  const unknownShapes = new Set<string>();
  const components = spec.nodes.map(node => makeComponent(node, fontSizePx, axis, unknownShapes));
  if (components.length === 0) {
    return { body: "", width: 0, height: 0, unknownShapes: [...unknownShapes] };
  }

  // 分层：BFS 入度 0 为首层。
  const levels = assignLayers(spec.nodes, spec.edges);
  const layerCount = Math.max(...components.map(comp => levels.get(comp.node.id) ?? 0)) + 1;
  const byLayer: Component[][] = Array.from({ length: layerCount }, () => []);
  for (const comp of components) byLayer[levels.get(comp.node.id) ?? 0].push(comp);

  // 主流向：逐层推进，层间距固定（层内元件端子之间留给连线）。
  let alongCursor = 0;
  for (const layer of byLayer) {
    const layerAlong = Math.max(...layer.map(comp => comp.uHalf * 2));
    const center = alongCursor + layerAlong / 2;
    for (const comp of layer) comp.u = center;
    alongCursor += layerAlong + LAYER_GAP;
  }

  // 垂主流向：同层内按输入顺序依次排布（层内元素互不压盖）。
  // 对齐基准是**导线轴**（局部 v=0）：元件本体可以上下不对称（接地符号的横线都在
  // 导线之下），若按本体盒边排布，不同层的导线轴会错开，连线就成了斜线。
  const layerCenters: number[] = [];
  for (const layer of byLayer) {
    let crossCursor = 0;
    for (const comp of layer) {
      const extra = LABEL_GAP + labelExtent(comp, axis, fontSizePx);
      comp.v = crossCursor;
      crossCursor = comp.v + comp.geometry.vMax + extra + SIB_GAP;
    }
    const centers = layer.map(comp => comp.v);
    layerCenters.push((Math.min(...centers) + Math.max(...centers)) / 2);
  }
  // 各层按符号中心对齐到全局中心（单元件的链因此落在同一条直线上）。
  const globalCenter = (Math.min(...layerCenters) + Math.max(...layerCenters)) / 2;
  byLayer.forEach((layer, index) => {
    const shift = globalCenter - (layerCenters[index] as number);
    for (const comp of layer) comp.v += shift;
  });

  // 连线：先数同一对节点的边数，再按序做平行偏移（避免多条边重叠成一条）。
  const byId = new Map(components.map(comp => [comp.node.id, comp]));
  const pairCounts = new Map<string, number>();
  for (const edge of spec.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const key = pairKey(edge.from, edge.to);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();

  const wirePrims: Primitive[] = [];
  for (const edge of spec.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const key = pairKey(edge.from, edge.to);
    const index = pairSeen.get(key) ?? 0;
    pairSeen.set(key, index + 1);
    const total = pairCounts.get(key) ?? 1;
    const offset = (index - (total - 1) / 2) * PARALLEL_STEP;

    // 端子选取：默认"背对背"（前侧出、后侧入）；同层时两侧都取前侧，
    // 使连线走在符号外侧而不是穿过符号本体。
    const sameLayer = from.u === to.u;
    const fromSign: 1 | -1 = sameLayer ? 1 : to.u > from.u ? 1 : -1;
    const toSign: 1 | -1 = sameLayer ? 1 : from.u < to.u ? -1 : 1;
    const start = terminalPoint(from, axis, fromSign);
    const end = terminalPoint(to, axis, toSign);

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    // 法向：优先取朝上（屏幕 -y）的方向；竖直连线时取朝左（屏幕 -x）。
    let nx = -dy / length;
    let ny = dx / length;
    if (Math.abs(dx) < Math.abs(dy)) {
      if (nx > 0) {
        nx = -nx;
        ny = -ny;
      }
    } else if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const offsetX = nx * offset;
    const offsetY = ny * offset;
    wirePrims.push({
      kind: "line",
      from: { x: start.x + offsetX, y: start.y + offsetY },
      to: { x: end.x + offsetX, y: end.y + offsetY },
      dashed: edge.dashed === true,
      role: "wire",
    });

    if (edge.label !== undefined && edge.label !== "") {
      const midX = (start.x + end.x) / 2 + offsetX;
      const midY = (start.y + end.y) / 2 + offsetY;
      const vertical = Math.abs(dx) < Math.abs(dy);
      const gap = LABEL_GAP + edgeFontSize * 0.8;
      wirePrims.push({
        kind: "text",
        x: vertical ? midX - gap : midX,
        y: vertical ? midY : midY - gap,
        size: edgeFontSize,
        anchor: vertical ? "end" : "middle",
        content: edge.label,
      });
    }
  }

  // 元件：先画连线再画元件（元件压线，视觉上元件在前）。
  const componentPrims: Primitive[] = [];
  const groupPrims: Primitive[][] = [];
  for (const comp of components) {
    const center = componentCenter(comp, axis);
    const painter = makePainter(axis, center);
    const own: Primitive[] = [];
    if (comp.symbol !== undefined) {
      paintSymbol(comp.symbol, axis, own, painter, comp.geometry);
    } else {
      // 装置框：矩形框 + 引线（框是普通矩形，不是电路符号）。
      // 圆角半径取仓库通用矩形的口径（rx=2），免得同一个"矩形"在两种渲染器里长得不一样。
      pushLine(own, painter, -comp.uHalf, 0, comp.geometry.backU, 0);
      pushLine(own, painter, comp.geometry.frontU, 0, comp.uHalf, 0);
      pushRect(own, painter, comp.geometry.uMin, comp.geometry.vMin, comp.geometry.uMax, comp.geometry.vMax, 2);
    }
    paintLabel(own, comp, axis, center, fontSizePx);
    componentPrims.push(...own);
    groupPrims.push(own);
  }

  const all = [...wirePrims, ...componentPrims];
  const bounds = primitivesBounds(all);
  const offsetX = MARGIN - bounds.minX;
  const offsetY = MARGIN - bounds.minY;
  const width = bounds.maxX - bounds.minX + MARGIN * 2;
  const height = bounds.maxY - bounds.minY + MARGIN * 2;

  // 元件分组（附图标记写 data-ref，供核验器回读）：与连线用同一个偏移量，
  // 否则符号与连线会落在两套坐标系里（图形整体错位）。
  const groups = components.map((comp, index) => {
    const refAttr = comp.node.ref === undefined ? "" : ` data-ref="${comp.node.ref}"`;
    return `<g id="n-${xmlId(comp.node.id)}"${refAttr}>${serialize(groupPrims[index] ?? [], offsetX, offsetY)}</g>`;
  });

  const body = `${serialize(wirePrims, offsetX, offsetY)}\n${groups.join("\n")}\n`;
  return { body, width, height, unknownShapes: [...unknownShapes] };
}

/** 一组图元的包围盒（含文字占位盒）。 */
function primitivesBounds(prims: readonly Primitive[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const prim of prims) {
    switch (prim.kind) {
      case "line":
        include(prim.from.x, prim.from.y);
        include(prim.to.x, prim.to.y);
        break;
      case "rect":
        include(prim.x, prim.y);
        include(prim.x + prim.width, prim.y + prim.height);
        break;
      case "circle":
        include(prim.cx - prim.r, prim.cy - prim.r);
        include(prim.cx + prim.r, prim.cy + prim.r);
        break;
      case "polygon":
      case "polyline":
        for (const point of prim.points) include(point.x, point.y);
        break;
      case "text": {
        const width = measureTextWidth(prim.content, prim.size);
        const left = prim.anchor === "middle" ? prim.x - width / 2 : prim.anchor === "end" ? prim.x - width : prim.x;
        include(left, prim.y - prim.size * 0.8);
        include(left + width, prim.y + prim.size * 0.2);
        break;
      }
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return { minX, minY, maxX, maxY };
}

/** 图元 → SVG 文本（坐标统一平移；描边/填充只有黑白两色）。 */
function serialize(prims: readonly Primitive[], offsetX: number, offsetY: number): string {
  const stroke = `stroke="${INK}" stroke-width="1.5"`;
  return prims
    .map(prim => {
      switch (prim.kind) {
        case "line": {
          const dash = prim.dashed ? ` stroke-dasharray="6 4"` : "";
          const role = prim.role === undefined ? "" : ` data-dsh-role="${prim.role}"`;
          return (
            `<line x1="${fmt(prim.from.x + offsetX)}" y1="${fmt(prim.from.y + offsetY)}" ` +
            `x2="${fmt(prim.to.x + offsetX)}" y2="${fmt(prim.to.y + offsetY)}" fill="none" ${stroke}${dash}${role}/>`
          );
        }
        case "rect":
          return (
            `<rect x="${fmt(prim.x + offsetX)}" y="${fmt(prim.y + offsetY)}" ` +
            `width="${fmt(prim.width)}" height="${fmt(prim.height)}" ` +
            `${prim.rx === undefined ? "" : `rx="${fmt(prim.rx)}" `}fill="#FFFFFF" ${stroke}/>`
          );
        case "circle":
          return (
            `<circle cx="${fmt(prim.cx + offsetX)}" cy="${fmt(prim.cy + offsetY)}" r="${fmt(prim.r)}" ` +
            `fill="#FFFFFF" ${stroke}/>`
          );
        case "polygon":
          return (
            `<polygon points="${prim.points.map(p => `${fmt(p.x + offsetX)},${fmt(p.y + offsetY)}`).join(" ")}" ` +
            `fill="#FFFFFF" ${stroke}/>`
          );
        case "polyline":
          return (
            `<polyline points="${prim.points.map(p => `${fmt(p.x + offsetX)},${fmt(p.y + offsetY)}`).join(" ")}" ` +
            `fill="none" ${stroke}/>`
          );
        case "text":
          return (
            `<text x="${fmt(prim.x + offsetX)}" y="${fmt(prim.y + offsetY)}" font-size="${prim.size}" ` +
            `text-anchor="${prim.anchor}" fill="${INK}">${escapeXml(prim.content)}</text>`
          );
      }
    })
    .join("");
}
