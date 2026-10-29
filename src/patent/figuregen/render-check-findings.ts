/**
 * render-check 的判据层：文字贯穿/净距、点划线覆盖、剖面线可辨、墨迹越界。
 *
 * 拆分自 `render-check.ts`；纯函数，输入是扫描层产出的毫米几何。
 */

import { inflateQuad, quadCrossedBySegment } from "./glyph-box.js";
import type {
  DrawnSegment,
  InkBounds,
  Occluder,
  Point,
  Poly,
  RenderCheckFinding,
  Scan,
  ScannedText,
  Segment,
} from "./render-check-types.js";
import {
  bounds,
  insidePolygon,
  length,
  orientation,
  quadCorners,
  quadSegmentDistance,
  textQuad,
  visiblePieces,
} from "./render-check-geometry.js";

/** 相邻判定：两轮廓包围盒间隙不超过此值（毫米）视为相邻零件。 */
const ADJACENT_GAP_MM = 1;
/**
 * 相邻零件剖面线取向差下限（度）：小于它则两件难以区分。
 * 沿用 deepseek-harness 的默认值，非本仓条文核验过的法条数值。
 */
const ADJACENT_ORIENTATION_LIMIT_DEG = 30;
/**
 * 相邻零件剖面线间距比上限：两件的实测间距之比（大／小）不超过它即视为「间距相近」。
 * GB/T 4457.5 只说「间距不等」，未给数值；取 1.5 倍是因为低于此比例的两档疏密在缩印到
 * 三分之二后仍读作同一种密度。
 *
 * 沿用 deepseek-harness 的默认值，非本仓条文核验过的法条数值。
 */
const ADJACENT_SPACING_RATIO_LIMIT = 1.5;
/**
 * 剖面线间距量测的最小投影差（毫米）：小于它的相邻投影差是同一条线的重复片段
 * （虚线展开、共线拼接），不参与间距计算。
 */
const HATCH_SPACING_MIN_GAP_MM = 0.1;
/**
 * 标号净距默认值（毫米）：文字占位框外扩这么多之后仍与图元相交即报。
 *
 * 取 1.5 毫米的依据是实测案例：A6 案（浅土层供热管道防腐蚀阴极保护装置）自建的净距
 * 判据在同批图上抓出 3 处「标号贴图线」缺陷，而只判「线条压进字身」的判据一处未报；
 * 1.5 毫米约为 3.5 毫米字号下字身与图线之间可读空白的下限。
 *
 * 沿用 deepseek-harness 的默认值，非本仓条文核验过的法条数值。
 */
export const DEFAULT_TEXT_CLEARANCE_MM = 1.5;
/** 点划线签名：短于此值的线段是「点」（毫米）。 */
const DOT_MAX_LENGTH_MM = 1;
/** 点划线签名：长于此值的线段是「长划」（毫米）。 */
const DASH_MIN_LENGTH_MM = 3;
/** 点划线签名下限：同一行至少这么多个「点」与「长划」才按点划线判定。 */
const DASH_DOT_MIN_DOTS = 3;
const DASH_DOT_MIN_DASHES = 2;
/** 点划线签名下限：整行跨度不得小于此值（毫米），排除零件轮廓的零碎短边。 */
const DASH_DOT_MIN_SPAN_MM = 20;
/**
 * 点划线长划的长度上界（毫米）：标准中心线的长划约 8 毫米（本包 `dashDotSegments`
 * 即 8 毫米）。同一行合并后若出现更长的连续墨迹，说明该行另有压在点划线上的实线
 * ——这是「点划线被实线覆盖」的判据，而不是把点划线自己的间隔当成实线。
 */
const DASH_DOT_MAX_DASH_MM = 10;
/** 行内可见间隙下限（毫米）：整行合并后无此宽度的空隙即视为「间隔不可见」。 */
const VISIBLE_GAP_MM = 1;
/** 同一直线上的坐标容差（毫米）。 */
const AXIS_TOLERANCE_MM = 0.05;
/** 判定两条轮廓互为镜像的顶点坐标容差（毫米）。 */
const MIRROR_TOLERANCE_MM = 0.01;
/**
 * 剖面线判定的最少平行线段数：零件内至少要这么多条同取向的线才算打了剖面线。
 * 取这些线是为了把「零件内的偶发线条」（电气符号的笔画、穿过零件的走线）排除在取向
 * 比较之外——它们的取向由符号画法决定，与剖面线无关。
 */
const HATCH_MIN_LINES = 3;

/**
 * 文字与图线的净距不足：占位框外扩 `clearanceMm` 后仍与图元线段相交即报，并给出两者
 * 的实测最短距离（毫米，一位小数）。
 *
 * 不参与判定的两类线段：**引线**（绘图侧标注 {@link ROLE_ATTRIBUTE}——引线本来就止于
 * 文字外框，把它算进来等于判工具自己画的每条引线都不合格）；**被遮挡面盖住的线段**
 * （更晚绘制的不透明填充之下，图面上看不见，见 {@link visiblePieces}）。
 *
 * 已被判为 `text-crossed-by-line` 的文字不再另报净距：线条压进字身时净距必然不足，
 * 重复报同一条缺陷只会淹没真正需要处理的那条。
 * @param texts - 图面上的文字。
 * @param drawn - 图元线段及其来源。
 * @param occluders - 遮挡面。
 * @param clearanceMm - 净距（毫米）；不大于 0 时不判。
 * @param crossed - 已判为被线条贯穿的文字下标集合。
 * @returns 发现的问题。
 */
export function textClearanceFindings(
  texts: readonly ScannedText[],
  drawn: readonly DrawnSegment[],
  occluders: readonly Occluder[],
  clearanceMm: number,
  crossed: ReadonlySet<number>,
): RenderCheckFinding[] {
  if (!(clearanceMm > 0)) return [];
  const findings: RenderCheckFinding[] = [];
  texts.forEach((text, index) => {
    if (crossed.has(index)) return;
    // 白色描边挖空的文字同样不判净距：白边本身就在字周围留出了视觉净空（见 haloedText）。
    if (text.haloed) return;
    const quad = textQuad(text);
    const inflated = inflateQuad(quad, clearanceMm);
    let nearest = Number.POSITIVE_INFINITY;
    for (const item of drawn) {
      if (item.leader) continue;
      for (const piece of visiblePieces(item, occluders)) {
        if (!quadCrossedBySegment(inflated, [piece.x1, piece.y1], [piece.x2, piece.y2])) continue;
        nearest = Math.min(nearest, quadSegmentDistance(quad, piece));
      }
    }
    if (!Number.isFinite(nearest)) return;
    findings.push({
      check: "text-clearance",
      message:
        `图面文字「${text.content}」距最近的图线仅 ${String(Math.round(nearest * 10) / 10)} 毫米，不足 ${String(clearanceMm)} 毫米净距：` +
        "标号与元件名周围要留出可读的空白，不与零件轮廓、剖面线或中心线贴靠",
    });
  });
  return findings;
}

/**
 * 两多边形是否为镜像（关于某条水平线或竖直线对称，且尺寸相同）：同一零件的上下或
 * 左右两半用同一剖面线取向，不应被判成「相邻零件取向过近」。
 *
 * 对称轴必须落在两个包围盒的**外边界**上（两半沿轴相接），否则会把并排的两个相同
 * 矩形误认成镜像（矩形关于自身中线也是对称的）。
 * @param a - 多边形 A 的顶点。
 * @param b - 多边形 B 的顶点。
 * @returns 互为镜像时 true。
 */
function isMirrorPair(a: Poly, b: Poly): boolean {
  if (a.length !== b.length) return false;
  const key = (points: Poly): string =>
    points
      .map(point => `${String(Math.round(point[0] * 1000))}:${String(Math.round(point[1] * 1000))}`)
      .sort()
      .join("|");
  const boxA = bounds(a);
  const boxB = bounds(b);
  const sameSize =
    Math.abs(boxA.maxX - boxA.minX - (boxB.maxX - boxB.minX)) <= MIRROR_TOLERANCE_MM &&
    Math.abs(boxA.maxY - boxA.minY - (boxB.maxY - boxB.minY)) <= MIRROR_TOLERANCE_MM;
  if (!sameSize) return false;
  /** 对称轴是否落在两盒之外（允许贴边）：落在盒内说明是同一侧的图形。 */
  const axisOutside = (axis: number, from: number, to: number): boolean =>
    axis <= from + MIRROR_TOLERANCE_MM || axis >= to - MIRROR_TOLERANCE_MM;
  const horizontalAxis = (boxA.minY + boxA.maxY + boxB.minY + boxB.maxY) / 4;
  if (axisOutside(horizontalAxis, boxA.minY, boxA.maxY) && axisOutside(horizontalAxis, boxB.minY, boxB.maxY)) {
    const reflected = b.map(point => [point[0], 2 * horizontalAxis - point[1]] as const);
    if (key(reflected) === key(a)) return true;
  }
  const verticalAxis = (boxA.minX + boxA.maxX + boxB.minX + boxB.maxX) / 4;
  if (axisOutside(verticalAxis, boxA.minX, boxA.maxX) && axisOutside(verticalAxis, boxB.minX, boxB.maxX)) {
    const reflected = b.map(point => [2 * verticalAxis - point[0], point[1]] as const);
    if (key(reflected) === key(a)) return true;
  }
  return false;
}

/**
 * 一个零件内剖面线的可辨别特征：取向（0.1° 分桶里重复最多的一条）与同取向平行线的
 * 相邻间距；没有任何取向达到 {@link HATCH_MIN_LINES} 条时 undefined（该零件没有剖面线）。
 * @param segments - 归入该零件的线段。
 * @returns 剖面线取向与间距；无剖面线时 undefined。
 */
function hatchSignature(
  segments: readonly Segment[],
): { readonly orientationDeg: number; readonly spacingMm: number | undefined } | undefined {
  const counts = new Map<number, number>();
  for (const segment of segments) {
    const key = Math.round(orientation(segment) * 10) / 10;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  if (best === undefined || bestCount < HATCH_MIN_LINES) return undefined;
  return { orientationDeg: best, spacingMm: hatchSpacing(segments, best) };
}

/**
 * 同取向剖面线的相邻间距（毫米）：把各线段中点投影到该取向的法线上排序，取**升序**相邻
 * 投影差的中位数（小于 {@link HATCH_SPACING_MIN_GAP_MM} 的差是同一条线的重复片段，跳过）。
 * 线段被轮廓裁短后中点仍落在自己那条线上，投影位置不受裁切影响；中位数对个别落单的线段
 * 稳健，等距剖面线上它与逐段间距同值。
 * @param segments - 归入该零件的线段。
 * @param orientationDeg - 剖面线取向（度），取自 {@link hatchSignature} 的众数分桶。
 * @returns 间距（毫米）；同取向线段不足两条或投影位置全部重合时 undefined。
 */
function hatchSpacing(segments: readonly Segment[], orientationDeg: number): number | undefined {
  const radians = (orientationDeg * Math.PI) / 180;
  const normalX = -Math.sin(radians);
  const normalY = Math.cos(radians);
  const offsets = segments
    .filter(segment => Math.round(orientation(segment) * 10) / 10 === orientationDeg)
    .map(segment => ((segment.x1 + segment.x2) / 2) * normalX + ((segment.y1 + segment.y2) / 2) * normalY)
    .sort((left, right) => left - right);
  const gaps = offsets
    .slice(1)
    .map((offset, index) => offset - (offsets[index] as number))
    .filter(gap => gap >= HATCH_SPACING_MIN_GAP_MM)
    .sort((left, right) => left - right);
  if (gaps.length === 0) return undefined;
  const half = Math.floor(gaps.length / 2);
  const middle = gaps.slice(gaps.length % 2 === 1 ? half : half - 1, half + 1);
  return middle.reduce((sum, gap) => sum + gap, 0) / middle.length;
}

/**
 * 两件的剖面线间距是否分不清：任一侧量不出间距时无法证明可区分，按分不清处理
 * （本判据只放宽、不收紧）。
 * @param left - 左件间距（毫米）；undefined 表示量不出。
 * @param right - 右件间距（毫米）；undefined 表示量不出。
 * @returns 间距相近时为 true。
 */
function spacingIndistinguishable(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  return Math.max(left, right) / Math.min(left, right) <= ADJACENT_SPACING_RATIO_LIMIT;
}

/** 轴对齐分组：同一行/列的线段集合（用于点划线覆盖判定）。 */
type AxisGroup = { readonly axis: "x" | "y"; readonly line: number; readonly segments: readonly Segment[] };

/** 按轴分组：同一坐标（容差 {@link AXIS_TOLERANCE_MM}）上的水平或竖直线段归为一组。 */
function intervalsByAxis(segments: readonly Segment[]): AxisGroup[] {
  const groups = new Map<string, { axis: "x" | "y"; line: number; segments: Segment[] }>();
  for (const segment of segments) {
    const horizontal = Math.abs(segment.y2 - segment.y1) <= AXIS_TOLERANCE_MM;
    const vertical = Math.abs(segment.x2 - segment.x1) <= AXIS_TOLERANCE_MM;
    if (!horizontal && !vertical) continue;
    const axis: "x" | "y" = horizontal ? "x" : "y";
    const line = horizontal ? (segment.y1 + segment.y2) / 2 : (segment.x1 + segment.x2) / 2;
    const key = `${axis}@${String(Math.round(line * 20) / 20)}`;
    const group = groups.get(key) ?? { axis, line, segments: [] };
    group.segments.push(segment);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 合并区间并按坐标排序。 */
function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1] + AXIS_TOLERANCE_MM) {
      last[1] = Math.max(last[1], range[1]);
      continue;
    }
    merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * 把一个线段按虚线段长切成「画」出的片段（间隔不产出线段）。
 *
 * 相位自线段起点起算：SVG 的虚线段沿子路径连续推进、由 `stroke-dashoffset` 起相，本模块
 * 对每段各自起算作近似——片段只用于点划线签名与覆盖判定，不用于坐标断言。
 * @param segment - 线段（毫米）。
 * @param patternMm - 虚线段长（毫米，画/空交替）。
 * @returns 画出的片段。
 */
export function dashSegments(segment: Segment, patternMm: readonly number[]): Segment[] {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const total = Math.hypot(dx, dy);
  if (total === 0) return [];
  const unit: Point = [dx / total, dy / total];
  const at = (distance: number): Point => [segment.x1 + unit[0] * distance, segment.y1 + unit[1] * distance];
  const pieces: Segment[] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < total) {
    const end = Math.min(cursor + (patternMm[index % patternMm.length] as number), total);
    if (index % 2 === 0 && end > cursor) {
      const from = at(cursor);
      const to = at(end);
      pieces.push({ x1: from[0], y1: from[1], x2: to[0], y2: to[1] });
    }
    cursor = end;
    index += 1;
  }
  return pieces;
}

/**
 * 点划线被实线覆盖：同一行（或列）既有点划签名（≥{@link DASH_DOT_MIN_DOTS} 个「点」与
 * ≥{@link DASH_DOT_MIN_DASHES} 个「长划」，整行跨度 ≥{@link DASH_DOT_MIN_SPAN_MM}），
 * 合并后没有 {@link VISIBLE_GAP_MM} 宽的可见空隙，且其中有一段长于
 * {@link DASH_DOT_MAX_DASH_MM} 的连续墨迹——点划线自己的长划不会那么长，故只可能来自
 * 压在同一位置的实线（上下两半剖的公共边正是如此）。
 *
 * 只按「间隔不可见」判定会把点划线自身间隔很小的图也报成实线覆盖，故必须有那段超长连续
 * 墨迹作依据；`stroke-dasharray` 画出的点划线已按虚线段展开（{@link dashSegments}），
 * 否则整条虚线只是一条长线段，签名与覆盖都看不出来。
 * @param pieces - 全部线段量测片段（虚线元素已展开成虚线段）。
 * @returns 发现的问题。
 */
export function coveredCenterlines(pieces: readonly Segment[]): RenderCheckFinding[] {
  const findings: RenderCheckFinding[] = [];
  for (const group of intervalsByAxis(pieces)) {
    const lengths = group.segments.map(length);
    const dots = lengths.filter(value => value <= DOT_MAX_LENGTH_MM).length;
    const dashes = lengths.filter(value => value >= DASH_MIN_LENGTH_MM).length;
    if (dots < DASH_DOT_MIN_DOTS || dashes < DASH_DOT_MIN_DASHES) continue;
    const ranges = group.segments.map(segment =>
      group.axis === "x"
        ? ([Math.min(segment.x1, segment.x2), Math.max(segment.x1, segment.x2)] as const)
        : ([Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2)] as const),
    );
    const merged = mergeRanges(ranges);
    const span = (merged[merged.length - 1] as [number, number])[1] - (merged[0] as [number, number])[0];
    if (span < DASH_DOT_MIN_SPAN_MM) continue;
    const gaps = merged.slice(1).map((range, index) => range[0] - (merged[index] as [number, number])[1]);
    // 合并后只剩一段 = 整行没有可见空隙：点与长划被实线连成一条线。
    const largestGap = gaps.length === 0 ? 0 : Math.max(...gaps);
    if (largestGap >= VISIBLE_GAP_MM) continue;
    const longestRun = Math.max(...merged.map(range => range[1] - range[0]));
    if (longestRun < DASH_DOT_MAX_DASH_MM) continue;
    findings.push({
      check: "centerline-covered",
      message:
        `图面 ${group.axis === "x" ? `y=${String(group.line)}` : `x=${String(group.line)}`} 处的点划线被同位置的实线覆盖` +
        `（该行有一段 ${String(Math.round(longestRun * 10) / 10)} 毫米的连续墨迹、间隔不可见）：` +
        "该行另有压在同一位置的实线边（例如上下两半剖的公共边），请改为一条闭合轮廓并只画中心线",
    });
  }
  return findings;
}

/**
 * 相邻零件剖面线难以区分：按「线段中点落在哪个多边形内」把剖面线归到零件，再对
 * 相邻（间隙 ≤ {@link ADJACENT_GAP_MM}）且非镜像对的多边形比较取向差与间距。只有两侧
 * 都真的带剖面线（{@link hatchSignature} 判定）时才比较，且**方向与间距都分不清**才报：
 * GB/T 4457.5 的判据是「方向相反或间距不等」，两项有一项可区分即不报。
 *
 * 带同一分组号（{@link HATCH_GROUP_ATTRIBUTE}）的两个轮廓是同一材料的几段，不比较：
 * 输入约定就是「同一零件的多个轮廓各给一段」，按轮廓比较必然把它们报成相邻两件。
 * @param outlines - 闭合轮廓。
 * @param segments - 线段（开放子路径：剖面线、引线、中心线；轮廓边不入内）。
 * @param groups - 与 `outlines` 一一对应的分组号；undefined 表示该轮廓自成一组。
 * @returns 发现的问题。
 */
export function hatchCollisions(
  outlines: readonly Poly[],
  segments: readonly Segment[],
  groups: readonly (number | undefined)[],
): RenderCheckFinding[] {
  const byPoly = new Map<number, Segment[]>();
  segments.forEach(segment => {
    const midpoint: Point = [(segment.x1 + segment.x2) / 2, (segment.y1 + segment.y2) / 2];
    outlines.forEach((poly, index) => {
      if (!insidePolygon(midpoint, poly)) return;
      const bucket = byPoly.get(index);
      if (bucket === undefined) byPoly.set(index, [segment]);
      else bucket.push(segment);
    });
  });
  const findings: RenderCheckFinding[] = [];
  const spacingText = (mm: number | undefined): string =>
    mm === undefined ? "间距未测出" : `间距 ${String(Math.round(mm * 10) / 10)} 毫米`;
  for (let left = 0; left < outlines.length; left += 1) {
    for (let right = left + 1; right < outlines.length; right += 1) {
      const group = groups[left];
      if (group !== undefined && group === groups[right]) continue;
      const a = outlines[left] as Poly;
      const b = outlines[right] as Poly;
      const boxA = bounds(a);
      const boxB = bounds(b);
      const gap = Math.max(
        Math.max(boxA.minX, boxB.minX) - Math.min(boxA.maxX, boxB.maxX),
        Math.max(boxA.minY, boxB.minY) - Math.min(boxA.maxY, boxB.maxY),
      );
      if (gap > ADJACENT_GAP_MM) continue;
      if (isMirrorPair(a, b)) continue;
      const hatchA = hatchSignature(byPoly.get(left) ?? []);
      const hatchB = hatchSignature(byPoly.get(right) ?? []);
      if (hatchA === undefined || hatchB === undefined) continue;
      const difference = Math.abs(hatchA.orientationDeg - hatchB.orientationDeg);
      const visual = Math.min(difference, 180 - difference);
      if (visual > ADJACENT_ORIENTATION_LIMIT_DEG) continue;
      if (!spacingIndistinguishable(hatchA.spacingMm, hatchB.spacingMm)) continue;
      findings.push({
        check: "hatch-orientation-collision",
        message:
          `相邻零件 #${String(left + 1)}（${String(hatchA.orientationDeg)}°／${spacingText(hatchA.spacingMm)}）` +
          `与 #${String(right + 1)}（${String(hatchB.orientationDeg)}°／${spacingText(hatchB.spacingMm)}）的剖面线方向仅差 ${String(Math.round(visual * 10) / 10)}°、间距也相近：` +
          "相邻零件的剖面线应方向相反或间距不等（GB/T 4457.5），否则读成一个零件",
      });
    }
  }
  return findings;
}

/**
 * 图面墨迹的包围盒：全部子路径顶点与文字占位框四角的并集。
 * @param scan - 遍历结果。
 * @returns 墨迹包围盒；没有可量测图元时 undefined。
 */
export function inkBounds(scan: Scan): InkBounds | undefined {
  const points: Point[] = [
    ...scan.shapes.flatMap(shape => shape.subpaths.flatMap(subpath => subpath.points)),
    ...scan.texts.flatMap(text => [...quadCorners(textQuad(text))]),
  ];
  return points.length === 0 ? undefined : bounds(points);
}

/**
 * 墨迹越出画布：全部子路径顶点与文字占位框四角中，有落在 [0, 画布] 之外的（容差
 * {@link AXIS_TOLERANCE_MM}）。根元素未声明两个尺寸时不做此判定。
 * @param scan - 遍历结果。
 * @returns 发现的问题；无法判定时 undefined。
 */
export function inkOutsideCanvas(scan: Scan): RenderCheckFinding | undefined {
  const { widthMm, heightMm } = scan;
  if (widthMm === undefined || heightMm === undefined) return undefined;
  const ink = inkBounds(scan);
  if (ink === undefined) return undefined;
  if (
    ink.minX >= -AXIS_TOLERANCE_MM &&
    ink.minY >= -AXIS_TOLERANCE_MM &&
    ink.maxX <= widthMm + AXIS_TOLERANCE_MM &&
    ink.maxY <= heightMm + AXIS_TOLERANCE_MM
  )
    return undefined;
  return {
    check: "ink-outside-canvas",
    message: `图面内容越出画布 ${String(widthMm)}×${String(heightMm)}：墨迹范围 (${String(ink.minX)}, ${String(ink.minY)})-(${String(ink.maxX)}, ${String(ink.maxY)})；越界部分不会渲染出来`,
  };
}

/** 元素重叠判定的最小相交尺寸（毫米）：小于它的相交是贴边/共线，不是重叠。 */
const OVERLAP_MIN_MM = 0.2;
/** 字高低于下限的发现最多逐条列出这么多条（其余合并为一条计数说明）。 */
const FONT_BELOW_MAX_DETAILS = 4;

/** 包围盒严格包含另一盒（一件套在另一件里：装配图的正常画法，不算重叠）。 */
function strictlyContains(
  outer: { minX: number; minY: number; maxX: number; maxY: number },
  inner: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;
}

/**
 * 图元互相重叠：两个闭合轮廓（或带描边的图元）包围盒在**两轴**上都相交且都超过
 * {@link OVERLAP_MIN_MM}。
 *
 * 排除三类：**严格包含**（一件套在另一件里，是装配图的正常画法）、**两侧都不描边**
 * （纯填充图元——文字转路径后的字形彼此压叠是排版常态，不是缺陷）、**同一分组号**
 * （同一材料的几段轮廓，见 `hatchCollisions`）。只相交一条窄边（贴边、共线）也不报。
 * @param outlines - 闭合轮廓。
 * @param groups - 与 `outlines` 一一对应的分组号；undefined 表示该轮廓自成一组。
 * @param stroked - 与 `outlines` 一一对应的「是否描边」。
 * @returns 发现的问题。
 */
export function outlineOverlaps(
  outlines: readonly Poly[],
  groups: readonly (number | undefined)[],
  stroked: readonly boolean[],
): RenderCheckFinding[] {
  const findings: RenderCheckFinding[] = [];
  for (let left = 0; left < outlines.length; left += 1) {
    for (let right = left + 1; right < outlines.length; right += 1) {
      const group = groups[left];
      if (group !== undefined && group === groups[right]) continue;
      if (stroked[left] !== true && stroked[right] !== true) continue;
      const a = bounds(outlines[left] as Poly);
      const b = bounds(outlines[right] as Poly);
      const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (overlapX <= OVERLAP_MIN_MM || overlapY <= OVERLAP_MIN_MM) continue;
      if (strictlyContains(a, b) || strictlyContains(b, a)) continue;
      findings.push({
        check: "element-overlap",
        message:
          `图元 #${String(left + 1)} 与 #${String(right + 1)} 的轮廓重叠 ` +
          `${String(Math.round(overlapX * 10) / 10)}×${String(Math.round(overlapY * 10) / 10)} 毫米：` +
          "两个零件/图形互相压叠时图面上读不出各自的边界，应错开摆放或改为一件在另一件之外的剖视画法",
      });
    }
  }
  return findings;
}

/**
 * 字高低于下限：逐条列出低于 `floorMm` 的文字（最多 {@link FONT_BELOW_MAX_DETAILS} 条，
 * 其余合并为计数），字高由调用方按文字占位框的实际四角算好（毫米，根坐标系）。
 *
 * 与 V7 的区别：V7 用**渲染器常数**估算整幅图的最小字，看不见同一幅图里更小的边标签；
 * 本判据量的是**实际文字元素**，故能报出「节点字够大、边标签不够」这类缺陷。
 * @param texts - 图面上的文字。
 * @param heightsMm - 与 `texts` 一一对应的实测字高（毫米）。
 * @param floorMm - 字高下限（毫米）；不大于 0 时不判。
 * @returns 发现的问题。
 */
export function fontBelowMinimum(
  texts: readonly ScannedText[],
  heightsMm: readonly number[],
  floorMm: number,
): RenderCheckFinding[] {
  if (!(floorMm > 0)) return [];
  const below = texts
    .map((text, index) => ({ text, heightMm: heightsMm[index] ?? Number.NaN }))
    .filter(entry => Number.isFinite(entry.heightMm) && entry.heightMm < floorMm);
  if (below.length === 0) return [];
  const findings: RenderCheckFinding[] = below.slice(0, FONT_BELOW_MAX_DETAILS).map(entry => ({
    check: "font-below-minimum",
    message:
      `图面文字「${entry.text.content}」字高约 ${String(Math.round(entry.heightMm * 100) / 100)} 毫米，` +
      `低于下限 ${String(floorMm)} 毫米：缩印到三分之二后更难辨认，应加大字号或减少文字`,
  }));
  if (below.length > FONT_BELOW_MAX_DETAILS) {
    findings.push({
      check: "font-below-minimum",
      message: `另有 ${String(below.length - FONT_BELOW_MAX_DETAILS)} 处文字低于 ${String(floorMm)} 毫米字高下限（未逐条列出）`,
    });
  }
  return findings;
}

/**
 * 量测一张 SVG 的墨迹包围盒（毫米，根坐标系）：全部子路径顶点与文字占位框的并集。
 *
 * 供「转换/改写后几何是否走样」的护栏使用（文字转轮廓路径后墨迹必须仍落在原范围内）；
 * 与 {@link checkFigureRendering} 共用同一遍历，故两处口径一致。
 * @param svg - 完整 SVG 文本。
 * @param options - 安全校验上限（字节）；缺省沿用 {@link DEFAULT_SVG_MAX_BYTES}。
 * @returns 墨迹包围盒；没有可量测图元时 undefined。
 * @throws SvgSafetyError 输入未通过 {@link assertSafeSvg} 时。
 */
