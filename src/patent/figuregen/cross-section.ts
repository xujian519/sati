/**
 * src/patent/figuregen — 二维剖视（cross-section）渲染器（纯 SVG 片段）。
 *
 * **语义**（GB/T 4457.5《机械制图 剖面区域的表示法》）：断面区域内画**细实线**的平行剖面线，
 * 与水平线成 45°，**同一零件间距相等、方向一致**，**相邻零件方向相反**（否则相邻材料区域在
 * 图面上被读成一个整体，件与件的分界就没了）。
 *
 * **输入口径**：坐标一律**归一化**（0..1，x 向右、y 向下）——调用方不必知道输出画布的像素尺寸，
 * 渲染器按包围盒等比映射（x 与 y 用**同一**缩放系数 ⇒ 形状不失真）后居中放置。
 *
 * **剖面线裁剪**（本模块的核心算法）：对每条平行线取其**法向偏移 c**，把多边形的每条边按
 * 「两端点是否落在 c 的同一侧」判交，交点沿线向排序后**两两配对**得到落在轮廓内的线段；孔用
 * 同一套算法求出孔内的区间，再从轮廓区间里**减掉**（孔是空的，孔内不填剖面线）。
 * 配对得到的线段还要过一次「中点是否在轮廓内部」的判定：与轮廓共线的退化线段（扫描线正好
 * 压在轮廓边上）其中点在边界上，会被剔除——否则会画出与轮廓重合的「假剖面线」。
 *
 * **图面合规**（审查指南 2023 一部一章 4.3/4.6）：
 * - 黑白不变式：描边与文字只用 `#000000`，填充只用 `none`（不画白填充，避免盖掉邻件的剖面线）；
 * - 剖面线一律细实线（线宽 1.0，比轮廓 1.5 细一档），不得妨碍附图标记线与主线条的清楚识别；
 * - 字号一律取入参（`fontSizePx` / `edgeFontSizePx`），本模块**不写死像素值**；
 * - 一切文本过 `escapeXml`，一切坐标过 `fmt`（不留浮点尾巴）。
 *
 * **纯函数**：无时钟、无随机、无字体测量（字宽按 `metrics.ts` 的字符类别累计）⇒ 同一输入
 * 两次调用逐字节相同。
 *
 * **回读兼容**：零件分组沿用内置渲染器的 `id="n-<partId>"` 契约并把 `ref` 写在 `data-ref` 上，
 * 故 `readback.ts` 能把断面零件读回成节点（V2/V3 的图↔文双向核对对剖视图同样成立）。
 * 轮廓多边形另写 `data-dsh-hatch-group`（同一零件的轮廓与孔共用一个组号），渲染复核据此把
 * 同一零件的轮廓归为一组、再比对相邻零件的剖面线取向（见 `render-check-scan.ts`）。
 *
 * @module src/patent/figuregen/cross-section
 */

import { measureTextWidth } from "./metrics.js";
import { withVisibleNumeral } from "./numeral-assign.js";
import { SVG_ROLE_ATTRIBUTE, escapeXml, fmt } from "./render-utils.js";
import type { FigureSectionPart, FigureSpec } from "./types.js";

/** 二维剖视布局产物：SVG 片段（不含 `<svg>` 根、不含 defs、不含图号）。 */
export type CrossSectionLayout = {
  /** SVG 片段（不含 <svg> 根、不含 defs、不含图号）。 */
  body: string;
  /** 画布宽（px）。 */
  width: number;
  /** 画布高（px）。 */
  height: number;
  /** 可选 defs（本模块不需要标记，缺省省略该字段）。 */
  defs?: string;
  /**
   * 实际采用的剖面线角度（度），按零件顺序一一对应。
   *
   * `no_hatch` 的零件也占一位（角度按零件序号交替，不因某个零件不剖而错位），但该角度
   * 没有落到图面上——报告出声时按「该零件未剖面」说明。
   */
  hatchAnglesDeg?: readonly number[];
};

/** 断面轮廓线宽（px）：与主线条同档（1.5）。 */
const OUTLINE_STROKE_WIDTH = 1.5;
/** 剖面线线宽（px）：比轮廓细一档（1.0）——GB/T 4457.5 要求剖面线为细实线。 */
const HATCH_STROKE_WIDTH = 1;
/** 剖面线间距（px）：模块缺省值（同一零件内等距）。 */
const DEFAULT_HATCH_SPACING_PX = 6;
/** 剖面线与水平线的夹角（度）：缺省 45°（GB/T 4457.5 的惯用角）。 */
const DEFAULT_HATCH_ANGLE_DEG = 45;
/** 画布四周留白（px）。 */
const CANVAS_MARGIN_PX = 20;
/**
 * 底部图号标注带（px）。
 *
 * 图号由调用方（`render-svg.ts` 的 `documentSvg`）画在图形正下方（指南一部一章 4.3），
 * 位置固定在画布底缘 `height - 16` 附近。本模块的入参里**没有**「要不要画图号」这个信号
 * （图号的有无由法域与图幅数决定），故一律预留这条带：多留 40px 空白只是图面略松，
 * 而漏留会让图号压住断面轮廓——后者是交付缺陷。
 */
const CAPTION_BAND_PX = 40;
/**
 * 标称图幅（px）：归一化包围盒的**较大边**映射到这个长度。
 *
 * 为什么不用「1 归一化单位 = 固定 px」：调用方给的轮廓常常只占归一化范围的一小段（实测
 * 常见 0.2..0.8），固定比例会让断面缩成几十 px、剖面线间距（px）反而比零件还大——图上
 * 一条剖面线都画不出来。按包围盒等比放大到标称图幅，既保证「x 与 y 同一缩放系数」不失真，
 * 又让剖面线密度与纸面观感稳定。
 */
const NOMINAL_DRAWING_PX = 480;
/**
 * 零件名与轮廓之间的**最小**间距（px）。
 *
 * 下限来自渲染复核的净距判据（RC2）：图面文字距最近的图线要留足 1.5 毫米净距。SVG 用户
 * 单位是 CSS px（1px = 25.4/96 毫米 ≈ 0.2646mm），故 1.5mm ≈ 5.7px；再减去文字基线以下的
 * 字深（0.12 倍字号），字号 14 时约需 7.4px ⇒ 取 10px 留出余量。字号更大时按比例放大
 * （见 {@link LABEL_GAP_RATIO}），否则大字号下净距又不够。
 */
const LABEL_GAP_MIN_PX = 10;
/** 零件名与轮廓间距的下限比例（相对字号）：大字号时净距随字号放大。 */
const LABEL_GAP_RATIO = 0.75;
/** 剖切线（剖切位置线）的点划节奏（stroke-dasharray）：长划—点—长划—点。 */
const CUT_LINE_DASH = "12 4 3 4";
/** 剖面线的图元角色（`data-dsh-role`）：便于机器回读与复核区分剖面线与轮廓线。 */
const HATCH_ROLE = "hatch";
/** 剖切线的图元角色（`data-dsh-role`）。 */
const CUT_ROLE = "cut";
/** 同一零件的轮廓分组属性（与 `render-check-scan.ts` 的读入口径同源）。 */
const HATCH_GROUP_ATTRIBUTE = "data-dsh-hatch-group";
/** 几何容差：浮点比较的同一把尺子。 */
const EPS = 1e-9;
/**
 * 剖面线端点的内缩（px）：线段两端各缩一点，使端点**严格**落在轮廓内部。
 *
 * 为什么缩：坐标写进 SVG 前要过 `fmt`（保留一位小数），端点可能被舍入到边界上甚至边界外
 * 一丝；轮廓线宽 1.5（半宽 0.75）本身盖住边界附近 0.75px，缩 0.3px 在图面上看不出来，
 * 却让「剖面线端点必在轮廓内」成为可断言的事实。
 */
const HATCH_INSET_PX = 0.3;
/** 基线以上的字高占字号之比（与 `glyph-box.ts` 的 GLYPH_ASCENT_RATIO 同口径）。 */
const GLYPH_ASCENT_RATIO = 0.75;
/** 基线以下的字深占字号之比（与 `glyph-box.ts` 的 GLYPH_DESCENT_RATIO 同口径）。 */
const GLYPH_DESCENT_RATIO = 0.12;

/** 点（px 或归一化坐标，x 向右、y 向下）。 */
type Point = readonly [number, number];
/** 轴对齐矩形。 */
type Box = { minX: number; minY: number; maxX: number; maxY: number };
/** 一条剖面线段。 */
type HatchSegment = { from: Point; to: Point };
/** 沿一条直线的一维区间（参数 = 沿直线方向的投影）。 */
type Interval = { from: number; to: number };

/** 零件 id → 合法 XML id 片段（与 `render-svg.ts` 同口径）。 */
function xmlId(nodeId: string): string {
  return nodeId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
}

/** 两点内积。 */
function dot(left: Point, right: Point): number {
  return left[0] * right[0] + left[1] * right[1];
}

/** 点的包围盒（空输入返回退化盒，调用方须自行判空）。 */
function boxOf(points: readonly Point[]): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const point of points) {
    if (point[0] < box.minX) box.minX = point[0];
    if (point[1] < box.minY) box.minY = point[1];
    if (point[0] > box.maxX) box.maxX = point[0];
    if (point[1] > box.maxY) box.maxY = point[1];
  }
  return box;
}

/** 两个盒的并集。 */
function unionBox(left: Box, right: Box): Box {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

/** 两盒是否相交（边界相切不算压盖）。 */
function boxesOverlap(left: Box, right: Box): boolean {
  return (
    left.minX < right.maxX - EPS &&
    right.minX < left.maxX - EPS &&
    left.minY < right.maxY - EPS &&
    right.minY < left.maxY - EPS
  );
}

/** 点是否落在线段上（含端点）。 */
function pointOnSegment(point: Point, from: Point, to: Point): boolean {
  const cross = (point[1] - from[1]) * (to[0] - from[0]) - (point[0] - from[0]) * (to[1] - from[1]);
  if (Math.abs(cross) > EPS) return false;
  const projection = (point[0] - from[0]) * (to[0] - from[0]) + (point[1] - from[1]) * (to[1] - from[1]);
  if (projection < 0) return false;
  const lengthSquared = (to[0] - from[0]) ** 2 + (to[1] - from[1]) ** 2;
  return projection <= lengthSquared;
}

/**
 * 点是否在多边形**内部**（边界上的点算「不在内部」）。
 *
 * 边界算外部是刻意的：与轮廓共线的剖面线段其中点正落在边界上，必须被剔除（否则会画出与
 * 轮廓重合的假剖面线）。
 */
function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index] as Point;
    const to = polygon[(index + 1) % polygon.length] as Point;
    if (pointOnSegment(point, from, to)) return false;
  }
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index] as Point;
    const to = polygon[(index + 1) % polygon.length] as Point;
    if (from[1] > point[1] !== to[1] > point[1]) {
      const crossing = from[0] + ((point[1] - from[1]) * (to[0] - from[0])) / (to[1] - from[1]);
      if (crossing > point[0]) inside = !inside;
    }
  }
  return inside;
}

/**
 * 一条直线（法向偏移 `offset`、法向 `normal`、方向 `direction`）与多边形的交点配对。
 *
 * 逐边判交用**半开区间**（法向偏移 > 0 的一侧算「上」）：扫描线正好穿过顶点时只计一次，
 * 不会把同一次穿越数成两次而错配成对。交点按沿线方向排序后两两配对 ⇒ 落在多边形内部的
 * 区间（简单多边形下配对即内外交替）。
 */
function lineIntervals(polygon: readonly Point[], offset: number, normal: Point, direction: Point): Interval[] {
  const crossings: number[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index] as Point;
    const to = polygon[(index + 1) % polygon.length] as Point;
    const fromSide = dot(from, normal) - offset;
    const toSide = dot(to, normal) - offset;
    if (fromSide > 0 === toSide > 0) continue;
    const ratio = fromSide / (fromSide - toSide);
    const hit: Point = [from[0] + ratio * (to[0] - from[0]), from[1] + ratio * (to[1] - from[1])];
    crossings.push(dot(hit, direction));
  }
  crossings.sort((left, right) => left - right);
  const intervals: Interval[] = [];
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const from = crossings[index] as number;
    const to = crossings[index + 1] as number;
    if (to - from <= EPS) continue;
    intervals.push({ from, to });
  }
  return intervals;
}

/** 区间集合相减：`base` 减去 `cuts`（同一维上的区间差集）。 */
function subtractIntervals(base: readonly Interval[], cuts: readonly Interval[]): Interval[] {
  if (cuts.length === 0) return base.map(interval => ({ ...interval }));
  const result: Interval[] = [];
  for (const piece of base) {
    let pieces: Interval[] = [{ ...piece }];
    for (const cut of cuts) {
      const next: Interval[] = [];
      for (const part of pieces) {
        if (cut.to <= part.from + EPS || cut.from >= part.to - EPS) {
          next.push(part);
          continue;
        }
        if (cut.from > part.from + EPS) next.push({ from: part.from, to: cut.from });
        if (cut.to < part.to - EPS) next.push({ from: cut.to, to: part.to });
      }
      pieces = next;
    }
    result.push(...pieces);
  }
  return result;
}

/** 直线上的点：法向偏移 `offset` + 沿线参数 `along`（normal 与 direction 正交且单位长）。 */
function pointOnLine(offset: number, along: number, normal: Point, direction: Point): Point {
  return [offset * normal[0] + along * direction[0], offset * normal[1] + along * direction[1]];
}

/**
 * 一个零件的剖面线（细实线族），全部裁剪在轮廓内部、且避开孔。
 *
 * @param outline - 断面轮廓（px）。
 * @param holes - 孔（px）；孔内不画剖面线。
 * @param angleDeg - 剖面线与水平线的夹角（度）。
 * @param spacing - 剖面线间距（px，沿法向量取⇒相邻线在纸面上的垂直距离恰为 spacing）。
 */
function hatchOf(
  outline: readonly Point[],
  holes: readonly (readonly Point[])[],
  angleDeg: number,
  spacing: number,
): HatchSegment[] {
  if (outline.length < 3 || !(spacing > 0)) return [];
  const radians = (angleDeg * Math.PI) / 180;
  const direction: Point = [Math.cos(radians), Math.sin(radians)];
  const normal: Point = [-Math.sin(radians), Math.cos(radians)];

  // 法向投影范围：决定要生成哪几条平行线。
  let minOffset = Infinity;
  let maxOffset = -Infinity;
  for (const point of outline) {
    const offset = dot(point, normal);
    if (offset < minOffset) minOffset = offset;
    if (offset > maxOffset) maxOffset = offset;
  }
  if (!(maxOffset > minOffset)) return [];

  // 相位：首条线取 minOffset + spacing/2 ⇒ 头尾两条线都不压在轮廓边界上。
  const first = minOffset + spacing / 2;
  const count = Math.ceil((maxOffset - first) / spacing);
  const segments: HatchSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = first + index * spacing;
    if (offset > maxOffset - EPS) break;
    const inside = lineIntervals(outline, offset, normal, direction).filter(interval => {
      const middle = (interval.from + interval.to) / 2;
      return pointInPolygon(pointOnLine(offset, middle, normal, direction), outline);
    });
    if (inside.length === 0) continue;
    const holeIntervals = holes.flatMap(hole => lineIntervals(hole, offset, normal, direction));
    for (const interval of subtractIntervals(inside, holeIntervals)) {
      const from = interval.from + HATCH_INSET_PX;
      const to = interval.to - HATCH_INSET_PX;
      if (to - from <= EPS) continue;
      segments.push({
        from: pointOnLine(offset, from, normal, direction),
        to: pointOnLine(offset, to, normal, direction),
      });
    }
  }
  return segments;
}

/** 角度归一到 [0, 180)（剖面线的方向按「与水平线的夹角」表示，180° 与 0° 等价）。 */
function normalizeAngle(angleDeg: number): number {
  const normalized = ((angleDeg % 180) + 180) % 180;
  return Math.round(normalized * 10) / 10;
}

/**
 * 相邻零件的剖面线方向：与基角**镜像**（180° − 基角）。
 *
 * 缺省基角 45° ⇒ 交替 45° / 135°（GB/T 4457.5 的惯用配对）。镜像在基角为 0°/90° 时会与
 * 基角重合（相邻零件方向一样 ⇒ 分不开），此时退让为基角 + 90°，保证「相邻可区分」这条
 * 硬要求在任何基角下都成立。
 */
function alternateAngle(baseAngleDeg: number): number {
  const mirrored = normalizeAngle(180 - baseAngleDeg);
  if (mirrored === baseAngleDeg) return normalizeAngle(baseAngleDeg + 90);
  return mirrored;
}

/** 线段是否与轴对齐矩形相交（Liang–Barsky 裁剪判据）。 */
function segmentHitsBox(from: Point, to: Point, box: Box): boolean {
  const deltaX = to[0] - from[0];
  const deltaY = to[1] - from[1];
  const edge = [-deltaX, deltaX, -deltaY, deltaY];
  const distance = [from[0] - box.minX, box.maxX - from[0], from[1] - box.minY, box.maxY - from[1]];
  let lower = 0;
  let upper = 1;
  for (let index = 0; index < 4; index += 1) {
    const direction = edge[index] as number;
    const gap = distance[index] as number;
    if (direction === 0) {
      if (gap < 0) return false;
      continue;
    }
    const ratio = gap / direction;
    if (direction < 0) {
      if (ratio > upper) return false;
      if (ratio > lower) lower = ratio;
    } else {
      if (ratio < lower) return false;
      if (ratio < upper) upper = ratio;
    }
  }
  return true;
}

/** 零件名（附图标记补全后）的图面文本与占位框。 */
type LabelPlan = {
  text: string;
  fontSize: number;
  /** 基线锚点 x（`text-anchor="start"`）。 */
  x: number;
  /** 基线 y。 */
  baseline: number;
  /** 占位框（用于避让与画布计算）。 */
  box: Box;
};

/**
 * 零件名的落位：优先放在轮廓包围盒**上方**，压到别的零件（或剖切线）时改放**右侧**。
 *
 * 为什么不放内部：零件名压在断面轮廓里会盖住剖面线（GB/T 4457.5 要求剖面线不得妨碍
 * 主线条与标记线的清楚识别）。放在外面还要避开邻件的轮廓，否则字会落在别人的剖面线上。
 *
 * @param part - 断面零件。
 * @param box - 该零件轮廓（含孔）的包围盒（px）。
 * @param obstacles - 需要避让的矩形（邻件的包围盒）。
 * @param cutSegment - 剖切线段（文字不得压在剖切线上）；缺省 undefined。
 * @param fontSizePx - 零件名字号（px）。
 * @param edgeFontSizePx - 独立附图标记的字号（px）。
 */
function planLabel(
  part: FigureSectionPart,
  box: Box,
  obstacles: readonly Box[],
  cutSegment: { from: Point; to: Point } | undefined,
  fontSizePx: number,
  edgeFontSizePx: number,
): LabelPlan | undefined {
  const raw = part.label ?? "";
  // 附图标记只画一次：label 已带可见标号时 `withVisibleNumeral` 原样返回。
  const text = part.ref === undefined ? raw : withVisibleNumeral(raw, part.ref);
  if (text.trim() === "") return undefined;
  // 有零件名的用主字号；只有裸附图标记（无零件名）的按附注字号。
  const fontSize = raw.trim() === "" ? edgeFontSizePx : fontSizePx;
  const width = measureTextWidth(text, fontSize);
  const ascent = fontSize * GLYPH_ASCENT_RATIO;
  const descent = fontSize * GLYPH_DESCENT_RATIO;
  // 间距随字号放大：大字号下固定间距不够渲染复核要的净距。
  const gap = Math.max(LABEL_GAP_MIN_PX, fontSize * LABEL_GAP_RATIO);

  const blocked = (candidate: Box): boolean =>
    obstacles.some(obstacle => boxesOverlap(candidate, obstacle)) ||
    (cutSegment !== undefined && segmentHitsBox(cutSegment.from, cutSegment.to, candidate));

  const above: LabelPlan = {
    text,
    fontSize,
    x: box.minX,
    baseline: box.minY - gap,
    box: {
      minX: box.minX,
      maxX: box.minX + width,
      minY: box.minY - gap - ascent,
      maxY: box.minY - gap + descent,
    },
  };
  if (!blocked(above.box)) return above;

  const centerY = (box.minY + box.maxY) / 2;
  const baseline = centerY + ((GLYPH_ASCENT_RATIO - GLYPH_DESCENT_RATIO) / 2) * fontSize;
  const right: LabelPlan = {
    text,
    fontSize,
    x: box.maxX + gap,
    baseline,
    box: {
      minX: box.maxX + gap,
      maxX: box.maxX + gap + width,
      minY: baseline - ascent,
      maxY: baseline + descent,
    },
  };
  if (!blocked(right.box)) return right;
  return above;
}

/** 多边形顶点 → SVG `points` 属性文本。 */
function pointsAttr(points: readonly Point[]): string {
  return points.map(point => `${fmt(point[0])},${fmt(point[1])}`).join(" ");
}

/**
 * 归一化坐标自检：必须落在 0..1 内且是有限数。
 *
 * 越界坐标会让「归一化」这个前提整个失效（画布按包围盒等比映射，越界点把图撑歪），
 * 且**无从向人解释**是哪一步错了——故在入参处当场报错，不产出半成品。
 */
function assertNormalized(points: readonly Point[], subject: string): void {
  for (const point of points) {
    for (const value of point) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(
          `${subject}的坐标必须落在归一化域 0..1 内（当前 ${String(value)}）：` +
            "断面坐标是相对画布的归一化值，不是像素",
        );
      }
    }
  }
}

/**
 * 渲染二维剖视（`kind: "cross-section"`）为 SVG 片段。
 *
 * @param spec - 附图描述（含 `section` 断面数据）。
 * @param options - 字号（px）：`fontSizePx` 用于零件名，`edgeFontSizePx` 用于独立附图标记。
 * @returns SVG 片段 + 画布尺寸 + 实际采用的剖面线角度。
 */
export function renderCrossSection(
  spec: FigureSpec,
  options: { fontSizePx: number; edgeFontSizePx: number },
): CrossSectionLayout {
  const section = spec.section;
  if (section === undefined || section.parts.length === 0) {
    throw new TypeError(
      "cross-section 附图缺少断面数据（spec.section 为空或 section.parts 为空）：拒绝输出没有断面的剖视图",
    );
  }

  // 1) 归一化 → px 的等比映射：包围盒的较大边映射到标称图幅，x/y 同一缩放系数（形状不失真）。
  const normalized: Point[] = [];
  for (const part of section.parts) {
    // 入参自检：坐标必须落在归一化域内、轮廓必须能闭合——**在入参处当场报错**，不产出
    // 半成品（越界坐标会让「归一化」这个前提失效，画出来的东西无从解释）。
    assertNormalized(part.outline, `零件「${part.id}」的断面轮廓`);
    for (const hole of part.holes ?? []) {
      assertNormalized(hole, `零件「${part.id}」的孔轮廓`);
      if (hole.length < 3) {
        throw new TypeError(`零件「${part.id}」的孔轮廓至少要 3 个顶点（当前 ${hole.length} 个）`);
      }
    }
    if (part.outline.length < 3) {
      throw new TypeError(
        `零件「${part.id}」的断面轮廓至少要 3 个顶点（当前 ${part.outline.length} 个）：` +
          "轮廓自动闭合，少于 3 点围不成断面",
      );
    }
    normalized.push(...part.outline);
    for (const hole of part.holes ?? []) normalized.push(...hole);
  }
  if (section.cut !== undefined) {
    assertNormalized(section.cut, "剖切线");
  }
  const bounds = boxOf(normalized);
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (!Number.isFinite(span) || !(span > 0)) {
    throw new TypeError("cross-section 断面轮廓退化（包围盒宽高为 0）：拒绝输出无内容的剖视图");
  }
  const scale = NOMINAL_DRAWING_PX / span;
  const toPx = (point: Point): Point => [(point[0] - bounds.minX) * scale, (point[1] - bounds.minY) * scale];

  // 2) 逐零件的像素几何（轮廓 + 孔）。顶点不足的轮廓在第 1 步已当场报错。
  const entries = section.parts.map((part, index) => {
    const outline = part.outline.map(toPx);
    const holes = (part.holes ?? []).map(hole => hole.map(toPx));
    const box = boxOf([...outline, ...holes.flat()]);
    return { part, index, outline, holes, box };
  });

  // 3) 剖面线参数：间距与基角（缺省取模块常量；非法入参回落缺省）。
  const spacing =
    section.hatch_spacing !== undefined && Number.isFinite(section.hatch_spacing) && section.hatch_spacing > 0
      ? section.hatch_spacing
      : DEFAULT_HATCH_SPACING_PX;
  const baseAngle =
    section.hatch_angle_deg !== undefined && Number.isFinite(section.hatch_angle_deg)
      ? normalizeAngle(section.hatch_angle_deg)
      : DEFAULT_HATCH_ANGLE_DEG;

  // 4) 剖面线：按零件序号交替方向（45° / 135°），逐件裁剪在轮廓内、避开孔。
  const hatchAnglesDeg: number[] = [];
  const hatches = new Map<string, HatchSegment[]>();
  for (const entry of entries) {
    const angle = entry.index % 2 === 0 ? baseAngle : alternateAngle(baseAngle);
    hatchAnglesDeg.push(angle);
    hatches.set(entry.part.id, entry.part.no_hatch === true ? [] : hatchOf(entry.outline, entry.holes, angle, spacing));
  }

  // 5) 零件名落位（避开邻件轮廓与剖切线）。
  const cutSegment =
    section.cut !== undefined && section.cut.length >= 2
      ? { from: toPx(section.cut[0] as Point), to: toPx(section.cut[1] as Point) }
      : undefined;
  const labels = new Map<string, LabelPlan | undefined>();
  for (const entry of entries) {
    const obstacles = entries
      .filter(other => other !== entry)
      .map(other => other.box)
      .concat(cutSegment === undefined ? [] : [boxOf([cutSegment.from, cutSegment.to])]);
    labels.set(
      entry.part.id,
      planLabel(entry.part, entry.box, obstacles, cutSegment, options.fontSizePx, options.edgeFontSizePx),
    );
  }

  // 6) 画布：内容包围盒 + 四周留白 + 底部图号带（内容在图号带以上居中）。
  let content = entries.reduce((accumulated, entry) => unionBox(accumulated, entry.box), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
  for (const entry of entries) {
    const label = labels.get(entry.part.id);
    if (label !== undefined) content = unionBox(content, label.box);
  }
  if (cutSegment !== undefined) content = unionBox(content, boxOf([cutSegment.from, cutSegment.to]));
  const width = content.maxX - content.minX + CANVAS_MARGIN_PX * 2;
  const height = content.maxY - content.minY + CANVAS_MARGIN_PX * 2 + CAPTION_BAND_PX;
  const offsetX = CANVAS_MARGIN_PX - content.minX;
  const offsetY = CANVAS_MARGIN_PX - content.minY;
  const shift = (point: Point): Point => [point[0] + offsetX, point[1] + offsetY];

  // 7) 出图：剖切线在下（点划线是位置标记，不该盖住断面），再是零件（剖面线 → 轮廓 → 零件名）。
  const cutMarkup =
    cutSegment === undefined
      ? ""
      : `<line x1="${fmt(cutSegment.from[0] + offsetX)}" y1="${fmt(cutSegment.from[1] + offsetY)}" ` +
        `x2="${fmt(cutSegment.to[0] + offsetX)}" y2="${fmt(cutSegment.to[1] + offsetY)}" ` +
        `fill="none" stroke="#000000" stroke-width="${fmt(OUTLINE_STROKE_WIDTH)}" ` +
        `stroke-dasharray="${CUT_LINE_DASH}" ${SVG_ROLE_ATTRIBUTE}="${CUT_ROLE}"/>`;

  const body = entries
    .map(entry => {
      const segments = hatches.get(entry.part.id) ?? [];
      const groupAttribute = ` ${HATCH_GROUP_ATTRIBUTE}="${entry.index}"`;
      const hatchMarkup = segments
        .map(segment => {
          const from = shift(segment.from);
          const to = shift(segment.to);
          return (
            `<line x1="${fmt(from[0])}" y1="${fmt(from[1])}" x2="${fmt(to[0])}" y2="${fmt(to[1])}" ` +
            `fill="none" stroke="#000000" stroke-width="${fmt(HATCH_STROKE_WIDTH)}" ` +
            `${SVG_ROLE_ATTRIBUTE}="${HATCH_ROLE}"${groupAttribute}/>`
          );
        })
        .join("");
      const outlineMarkup =
        `<polygon points="${pointsAttr(entry.outline.map(shift))}" fill="none" stroke="#000000" ` +
        `stroke-width="${fmt(OUTLINE_STROKE_WIDTH)}"${groupAttribute}/>`;
      const holeMarkup = entry.holes
        .map(hole => {
          return (
            `<polygon points="${pointsAttr(hole.map(shift))}" fill="none" stroke="#000000" ` +
            `stroke-width="${fmt(OUTLINE_STROKE_WIDTH)}"${groupAttribute}/>`
          );
        })
        .join("");
      const label = labels.get(entry.part.id);
      const labelMarkup =
        label === undefined
          ? ""
          : `<text x="${fmt(label.x + offsetX)}" y="${fmt(label.baseline + offsetY)}" ` +
            `font-size="${fmt(label.fontSize)}" text-anchor="start" fill="#000000">` +
            `${escapeXml(label.text)}</text>`;
      const refAttribute = entry.part.ref === undefined ? "" : ` data-ref="${entry.part.ref}"`;
      return `<g id="n-${xmlId(entry.part.id)}"${refAttribute}>${hatchMarkup}${outlineMarkup}${holeMarkup}${labelMarkup}</g>`;
    })
    .join("");

  return { body: cutMarkup + body, width, height, hatchAnglesDeg };
}
