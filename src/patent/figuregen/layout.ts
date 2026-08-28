/**
 * src/patent/figuregen — 确定性分层布局器。
 *
 * flowchart 默认 TB、block 默认 LR；最长路径分层（回边跳过，保证有环输入不死循环），
 * 同层按输入顺序横向排布。输出为渲染所需的节点盒与边折线（含边标签落点）。
 * 全程无随机/时钟输入：同一 FigureSpec 永远产出同一布局（快照测试的前提）。
 */

import type { FigureDirection, FigureEdge, FigureKind, FigureNode, FigureSpec } from "./types.js";

export type Point = { x: number; y: number };

export type PositionedNode = {
  node: FigureNode;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RoutedEdge = {
  edge: FigureEdge;
  points: Point[];
  /** 边标签中心落点（有 label 时存在）。 */
  labelAt?: Point;
};

export type FigureLayout = {
  nodes: PositionedNode[];
  edges: RoutedEdge[];
  width: number;
  height: number;
};

/** 尺寸度量：fontsize 14 的 CJK 近似字宽、行高，内边距与最小盒尺寸。 */
const CHAR_W = 15;
const LINE_H = 21;
const PAD_X = 16;
const PAD_Y = 12;
const MIN_W = 72;
const MIN_H = 42;
const MARGIN = 28;
const LAYER_GAP = 64;
const SIB_GAP = 32;
const CAPTION_H = 40;

export function defaultDirection(kind: FigureKind): FigureDirection {
  return kind === "block" ? "LR" : "TB";
}

function nodeSize(node: FigureNode): { width: number; height: number } {
  const lines = node.label.split("\n");
  const longest = Math.max(...lines.map(line => line.length));
  return {
    width: Math.max(MIN_W, longest * CHAR_W + PAD_X * 2),
    height: Math.max(MIN_H, lines.length * LINE_H + PAD_Y * 2),
  };
}

/** 最长路径分层：layer(n) = 0（无有效前驱）或 max(layer(pred))+1；回边跳过。 */
function assignLayers(nodes: readonly FigureNode[], edges: readonly FigureEdge[]): Map<string, number> {
  const incoming = new Map<string, FigureEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }
  const depth = new Map<string, number>();
  const inStack = new Set<string>();

  const depthOf = (id: string): number => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    if (inStack.has(id)) return -1; // 回边：不参与分层
    inStack.add(id);
    let best = -1;
    for (const edge of incoming.get(id) ?? []) {
      if (inStack.has(edge.from)) continue;
      best = Math.max(best, depthOf(edge.from));
    }
    inStack.delete(id);
    const value = best + 1;
    depth.set(id, value);
    return value;
  };

  for (const node of nodes) depthOf(node.id);
  return depth;
}

/**
 * 布局单幅附图。direction 缺省按 kind 取默认（flowchart=TB，block=LR）。
 */
export function layoutFigure(spec: FigureSpec): FigureLayout {
  const direction = spec.direction ?? defaultDirection(spec.kind);
  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of spec.nodes) sizes.set(node.id, nodeSize(node));

  const layers = assignLayers(spec.nodes, spec.edges);
  const maxLayer = Math.max(-1, ...spec.nodes.map(n => layers.get(n.id) ?? 0));

  // 同层内按输入顺序排布
  const rows: FigureNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const node of spec.nodes) rows[layers.get(node.id) ?? 0].push(node);

  const rowHeights = rows.map(row => Math.max(1, ...row.map(n => sizes.get(n.id)!.height)));
  const contentW = Math.max(
    1,
    ...rows.map(row => row.reduce((sum, n) => sum + sizes.get(n.id)!.width, 0) + Math.max(0, row.length - 1) * SIB_GAP),
  );
  const contentH = rowHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, rows.length - 1) * LAYER_GAP;
  const width = contentW + MARGIN * 2;
  const height = contentH + MARGIN * 2 + CAPTION_H;

  // 主轴坐标 = 分层方向（TB: y，LR: x）；副轴 = 层内顺序
  const positioned = new Map<string, PositionedNode>();
  let cross = MARGIN;
  for (const [rowIndex, row] of rows.entries()) {
    let along = MARGIN;
    for (const node of row) {
      const size = sizes.get(node.id)!;
      const x = direction === "TB" ? along : cross;
      const y = direction === "TB" ? cross : along;
      positioned.set(node.id, { node, x, y, width: size.width, height: size.height });
      along += size.width + SIB_GAP;
    }
    cross += rowHeights[rowIndex] + LAYER_GAP;
  }

  const center = (p: PositionedNode) => ({
    cx: p.x + p.width / 2,
    cy: p.y + p.height / 2,
  });

  const routedEdges: RoutedEdge[] = spec.edges.flatMap(edge => {
    const source = positioned.get(edge.from);
    const target = positioned.get(edge.to);
    if (!source || !target) return [];

    let points: Point[];
    let labelAt: Point | undefined;
    if (direction === "TB") {
      const s = center(source);
      const t = center(target);
      const midY = (source.y + source.height + target.y) / 2;
      points =
        Math.abs(s.cx - t.cx) < 1
          ? [
              { x: s.cx, y: source.y + source.height },
              { x: t.cx, y: target.y },
            ]
          : [
              { x: s.cx, y: source.y + source.height },
              { x: s.cx, y: midY },
              { x: t.cx, y: midY },
              { x: t.cx, y: target.y },
            ];
      labelAt = { x: (s.cx + t.cx) / 2, y: midY - 8 };
    } else {
      const s = center(source);
      const t = center(target);
      const midX = (source.x + source.width + target.x) / 2;
      points =
        Math.abs(s.cy - t.cy) < 1
          ? [
              { x: source.x + source.width, y: s.cy },
              { x: target.x, y: t.cy },
            ]
          : [
              { x: source.x + source.width, y: s.cy },
              { x: midX, y: s.cy },
              { x: midX, y: t.cy },
              { x: target.x, y: t.cy },
            ];
      labelAt = { x: midX, y: (s.cy + t.cy) / 2 - 8 };
    }
    return [{ edge, points, ...(edge.label ? { labelAt } : {}) }];
  });

  return { nodes: [...positioned.values()], edges: routedEdges, width, height };
}
