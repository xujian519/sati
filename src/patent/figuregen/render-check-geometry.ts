/**
 * render-check 的几何判据层：线段/包围盒/遮挡可见性/净距距离。
 *
 * 拆分自 `render-check.ts`；纯函数，输入是根坐标系下的毫米几何。
 */

import type { GlyphQuad } from "./glyph-box.js";
import { mapPoint } from "./render-check-scan.js";
import type { DrawnSegment, Occluder, Point, Poly, Quad, ScannedText, Segment, SubPath } from "./render-check-types.js";

/** 判定线段同一位置时的坐标容差（毫米，遮挡切分用）。 */
const SPLIT_TOLERANCE = 1e-9;

/**
 * 文字占位框在图面上的像：原点取框左上角的像，两条边向量取框的两条边经同一变换后的像。
 * @param text - 文字记录。
 * @returns 仿射矩形（根坐标系，毫米）。
 */
export function textQuad(text: ScannedText): GlyphQuad {
  const origin = mapPoint(text.matrix, [text.box.minX, text.box.minY]);
  const across = mapPoint(text.matrix, [text.box.maxX, text.box.minY]);
  const down = mapPoint(text.matrix, [text.box.minX, text.box.maxY]);
  return {
    origin,
    edgeWidth: [across[0] - origin[0], across[1] - origin[1]],
    edgeHeight: [down[0] - origin[0], down[1] - origin[1]],
  };
}

/**
 * 仿射矩形的四角（左上、右上、右下、左下）。
 * @param quad - 仿射矩形。
 * @returns 四角坐标。
 */
export function quadCorners(quad: GlyphQuad): Quad {
  const [originX, originY] = quad.origin;
  const [widthX, widthY] = quad.edgeWidth;
  const [heightX, heightY] = quad.edgeHeight;
  return [
    [originX, originY],
    [originX + widthX, originY + widthY],
    [originX + widthX + heightX, originY + widthY + heightY],
    [originX + heightX, originY + heightY],
  ];
}

/** 子路径的线段：相邻顶点各一段，闭合子路径另加收口边。 */
export function subpathSegments(subpath: SubPath): Segment[] {
  const segments: Segment[] = [];
  for (let index = 0; index + 1 < subpath.points.length; index += 1) {
    const from = subpath.points[index] as Point;
    const to = subpath.points[index + 1] as Point;
    segments.push({ x1: from[0], y1: from[1], x2: to[0], y2: to[1] });
  }
  if (subpath.closed) {
    const first = subpath.points[0] as Point;
    const last = subpath.points[subpath.points.length - 1] as Point;
    segments.push({ x1: last[0], y1: last[1], x2: first[0], y2: first[1] });
  }
  return segments;
}

/** 线段长度。 */
export function length(segment: Segment): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

/** 线段取向归一化到 [0, 180)。 */
export function orientation(segment: Segment): number {
  const degrees = (Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1) * 180) / Math.PI;
  return ((degrees % 180) + 180) % 180;
}

/** 包围盒。 */
export function bounds(points: Poly): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** 点是否在多边形内（even-odd 射线法）。 */
export function insidePolygon(point: Point, points: Poly): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const a = points[index] as Point;
    const b = points[previous] as Point;
    if (a[1] > point[1] === b[1] > point[1]) continue;
    const x = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (point[0] < x) inside = !inside;
  }
  return inside;
}

/**
 * 线段与遮挡面的交点参数：`t` 落在线段内、`u` 落在遮挡边内时才计入。
 * @param segment - 线段。
 * @param from - 遮挡边起点。
 * @param to - 遮挡边终点。
 * @returns 交点参数 `t`；不相交或平行时为 undefined。
 */
function crossingParameter(segment: Segment, from: Point, to: Point): number | undefined {
  const segmentX = segment.x2 - segment.x1;
  const segmentY = segment.y2 - segment.y1;
  const edgeX = to[0] - from[0];
  const edgeY = to[1] - from[1];
  const determinant = segmentX * edgeY - segmentY * edgeX;
  if (determinant === 0) return undefined;
  const offsetX = from[0] - segment.x1;
  const offsetY = from[1] - segment.y1;
  const t = (offsetX * edgeY - offsetY * edgeX) / determinant;
  const u = (offsetX * segmentY - offsetY * segmentX) / determinant;
  if (t <= 0 || t >= 1 || u < 0 || u > 1) return undefined;
  return t;
}

/**
 * 线段在图面上可见的部分：被遮挡面（更晚绘制的不透明填充）盖住的段不可见，不参与文字判定。
 *
 * 沿与遮挡面各边的交点把线段切开，逐段取中点判定是否落在某个遮挡面内——直线段的
 * 「在面内／面外」只会在与边界相交处改变，故按交点切分即得精确结果（凹多边形同样成立）。
 * 没有更晚绘制的遮挡面时原样返回（本包两条绘制通路都不写填充，故缺省零开销）。
 * @param drawn - 线段及其文档序。
 * @param occluders - 遮挡面（闭合轮廓 + 文档序）。
 * @returns 可见片段（至少……切分后可能为空数组）。
 */
export function visiblePieces(drawn: DrawnSegment, occluders: readonly Occluder[]): readonly Segment[] {
  const covers = occluders.filter(occluder => occluder.order > drawn.order);
  if (covers.length === 0) return [drawn.segment];
  const { segment } = drawn;
  const cuts: number[] = [];
  for (const occluder of covers) {
    for (let index = 0; index < occluder.points.length; index += 1) {
      const from = occluder.points[index] as Point;
      const to = occluder.points[(index + 1) % occluder.points.length] as Point;
      const t = crossingParameter(segment, from, to);
      if (t !== undefined && !cuts.some(value => Math.abs(value - t) <= SPLIT_TOLERANCE)) cuts.push(t);
    }
  }
  const stops = [0, ...cuts.sort((left, right) => left - right), 1];
  const pieces: Segment[] = [];
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const from = stops[index] as number;
    const to = stops[index + 1] as number;
    const at = (t: number): Point => [
      segment.x1 + (segment.x2 - segment.x1) * t,
      segment.y1 + (segment.y2 - segment.y1) * t,
    ];
    const middle = at((from + to) / 2);
    if (covers.some(occluder => insidePolygon(middle, occluder.points))) continue;
    const start = at(from);
    const end = at(to);
    pieces.push({ x1: start[0], y1: start[1], x2: end[0], y2: end[1] });
  }
  return pieces;
}

/** 点到线段的最短距离（毫米）。 */
function pointSegmentDistance(point: Point, segment: Segment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point[0] - segment.x1) * dx + (point[1] - segment.y1) * dy) / lengthSquared));
  return Math.hypot(point[0] - (segment.x1 + dx * t), point[1] - (segment.y1 + dy * t));
}

/** 点在有向直线 `from→to` 的哪一侧（叉积符号）。 */
function sideOf(from: Point, to: Point, point: Point): number {
  return (to[0] - from[0]) * (point[1] - from[1]) - (to[1] - from[1]) * (point[0] - from[0]);
}

/** 点是否落在线段上（共线且落在两端之间）。 */
function onSegment(point: Point, segment: Segment): boolean {
  return (
    sideOf([segment.x1, segment.y1], [segment.x2, segment.y2], point) === 0 &&
    point[0] >= Math.min(segment.x1, segment.x2) &&
    point[0] <= Math.max(segment.x1, segment.x2) &&
    point[1] >= Math.min(segment.y1, segment.y2) &&
    point[1] <= Math.max(segment.y1, segment.y2)
  );
}

/** 两线段是否相交（含端点接触与共线重叠）。 */
function segmentsIntersect(a: Segment, b: Segment): boolean {
  const a1: Point = [a.x1, a.y1];
  const a2: Point = [a.x2, a.y2];
  const b1: Point = [b.x1, b.y1];
  const b2: Point = [b.x2, b.y2];
  const d1 = sideOf(a1, a2, b1);
  const d2 = sideOf(a1, a2, b2);
  const d3 = sideOf(b1, b2, a1);
  const d4 = sideOf(b1, b2, a2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return onSegment(b1, a) || onSegment(b2, a) || onSegment(a1, b) || onSegment(a2, b);
}

/** 两线段的最短距离（毫米）：相交为 0，否则取四个端点到对侧线段的最短距离。 */
export function segmentDistance(a: Segment, b: Segment): number {
  if (segmentsIntersect(a, b)) return 0;
  return Math.min(
    pointSegmentDistance([a.x1, a.y1], b),
    pointSegmentDistance([a.x2, a.y2], b),
    pointSegmentDistance([b.x1, b.y1], a),
    pointSegmentDistance([b.x2, b.y2], a),
  );
}

/** 仿射矩形到线段的最短距离（毫米）：取四条边各自到该线段的最短距离。 */
export function quadSegmentDistance(quad: GlyphQuad, segment: Segment): number {
  const corners = quadCorners(quad);
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index] as Point;
    const to = corners[(index + 1) % corners.length] as Point;
    best = Math.min(best, segmentDistance({ x1: from[0], y1: from[1], x2: to[0], y2: to[1] }, segment));
  }
  return best;
}
