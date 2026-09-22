/**
 * src/patent/figuregen — 曲线图/坐标图（直接绘制的矢量通路，纯函数）。
 *
 * 与分层布局器（`layout.ts`）平行的第二条通路：流程图/框图/状态图/层级图是"节点 + 边"的
 * 图论结构，曲线图是"坐标轴 + 数据序列"的数值图形——Graphviz 与分层布局都表达不了，
 * 故本模块自绘。同一份 FigureSpec 永远产出同一布局与同一 SVG 片段（无随机/时钟/字体测量）。
 *
 * 图面合规（细则 2023 第 21 条第 3 款、审查指南 2023 一部一章 4.3/4.6）：
 * - 黑白不变式：只用 `#000000`/`#FFFFFF`，无渐变、无彩色函数；
 * - **不得用颜色区分曲线**：黑白附图上颜色不可用，标记形状与线型是唯二的区分手段
 *   ⇒ 未指定标记的多序列按固定顺序自动分配不同标记（check 的 V20 报显式重复）；
 * - 不写比例、不画尺寸线（PCT 申请人指南 IP 5.150 对 Rule 11.13(c) 的释义、37 CFR 1.84(k)
 *   禁止 "actual size"/"scale 1/2" 一类标注）；
 * - 图号由 `render-svg.ts` 统一加在图形正下方（4.3"标注在相应附图的正下方"），本模块只管图形。
 *
 * 坐标单位为 px（与其余图型同源，纸面毫米由 `page-contract.ts` 的统一缩放换算），
 * 字号取 `FIGURE_FONT_SIZE`——核验器 V7 的打印字高判据因此对曲线图同样成立。
 */

import { FIGURE_FONT_SIZE, measureTextWidth } from "./metrics.js";
import type { ChartAxis, ChartLineStyle, ChartMarker, ChartSeries, FigureChart } from "./types.js";

export type Point = { x: number; y: number };

/** 标记的默认分配顺序：先实心后空心，形状差异在小尺寸下最易分辨。 */
export const CHART_MARKER_CYCLE: readonly ChartMarker[] = [
  "filled-circle",
  "filled-square",
  "filled-triangle",
  "circle",
  "square",
  "triangle",
  "cross",
  "plus",
];

/** 定形后的序列（标记与线型已按默认规则补齐）。 */
export type ResolvedChartSeries = {
  series: ChartSeries;
  /** 序列序号（0 起），缺省标记按它取模分配。 */
  index: number;
  marker: ChartMarker;
  line: ChartLineStyle;
};

/** 图面词语的定位（供 check 的 V12/V13 证据行复用）。 */
export type ChartLabel = { where: string; text: string };

export type ChartTick = { text: string; position: number };

export type ChartLayout = {
  width: number;
  height: number;
  /** 绘图区（左/上/右/下）边线坐标。 */
  plot: { left: number; top: number; right: number; bottom: number };
  grid: boolean;
  xTitle: string;
  yTitle: string;
  /** 文本落点（布局一次算定，渲染不再重算——两处各算一遍会漂移）。 */
  xLabelBaseline: number;
  xTitleBaseline: number;
  yTitleX: number;
  /** 横轴刻度（position=画布 x）与纵轴刻度（position=画布 y）。 */
  xTicks: readonly ChartTick[];
  yTicks: readonly ChartTick[];
  /** 映射到画布坐标的数据序列。 */
  series: readonly { resolved: ResolvedChartSeries; points: readonly Point[] }[];
  /** 图例行（每行的条目与文本基线 y）。 */
  legend: readonly { entries: readonly ResolvedChartSeries[]; baseline: number }[];
};

/** 刻度数取值域（含两端）：1 个刻度等于没有刻度，十几段刻度在小画幅上会挤成一团。 */
const MIN_TICK_COUNT = 2;
const MAX_TICK_COUNT = 12;
const DEFAULT_TICK_COUNT = 5;

/** 画布与绘图区尺寸（px）。 */
const EDGE_PAD = 16;
const PLOT_WIDTH = 440;
const PLOT_HEIGHT = 300;

/** 轴线装饰：刻度线长度、刻度值间隙、标目间隙、轴端开口箭头。 */
const AXIS_TICK = 6;
const TICK_LABEL_GAP = 4;
const AXIS_TITLE_GAP = 12;
const ARROW_LENGTH = 10;
const ARROW_HALF_WIDTH = 4;

/** 图例：行高、条目间距、示例线段长度。 */
const LEGEND_ROW_H = 24;
const LEGEND_GAP_X = 28;
const LEGEND_SWATCH_W = 20;

/** 线宽与标记尺寸。 */
const AXIS_STROKE = 1.5;
const SERIES_STROKE = 1.5;
const TICK_STROKE = 1;
const GRID_STROKE = 0.8;
const MARKER_RADIUS = 4;

/** 文本基线相对几何中心的垂直微调（字号比例）。 */
const BASELINE_MID = 0.35;

/** 自动范围的取整步长档（1/2/2.5/5 × 10^n：刻度值落在整档上，不是数据的原始极值）。 */
const NICE_MULTIPLES: readonly number[] = [1, 2, 2.5, 5];

/** 图号标注带高度（与 layout.ts 的 CAPTION_H 同源：渲染器把图号画在这条带里）。 */
const CAPTION_H = 40;

/** 空曲线图：`kind: "chart"` 但缺 `chart` 字段时出一张空坐标图（缺陷由工具校验与 V-规则报告，渲染不抛错）。 */
const EMPTY_AXIS: ChartAxis = { title: "" };

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 刻度值文本：保留 6 位小数后去掉浮点噪声（0.30000000000000004 → 0.3）。 */
function fmtTick(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function seriesOf(chart: FigureChart | undefined): readonly ChartSeries[] {
  return chart?.series ?? [];
}

/** 定形序列：补齐缺省标记（按序号取模分配，保证多序列在黑白图面上可区分）与缺省线型。 */
export function resolveChartSeries(chart: FigureChart | undefined): ResolvedChartSeries[] {
  return seriesOf(chart).map((series, index) => ({
    series,
    index,
    marker: series.marker ?? CHART_MARKER_CYCLE[index % CHART_MARKER_CYCLE.length]!,
    line: series.line ?? "solid",
  }));
}

/**
 * 图面上无法区分的曲线组合（证据行；空数组=可区分）。
 *
 * 黑白附图上曲线只能靠标记与线型区分：两者都相同的两条曲线在图中没有任何差别
 * （这是渲染契约，不是条文要求——与 V18 同类的"静默丢失"缺陷）。
 */
export function chartStyleConflicts(chart: FigureChart | undefined): string[] {
  const seen = new Map<string, string[]>();
  for (const resolved of resolveChartSeries(chart)) {
    const key = `${resolved.line}|${resolved.marker}`;
    const names = seen.get(key) ?? [];
    names.push(resolved.series.name?.trim() || `第 ${resolved.index + 1} 条`);
    seen.set(key, names);
  }
  const evidence: string[] = [];
  for (const [key, names] of seen) {
    if (names.length < 2) continue;
    const [line, marker] = key.split("|");
    evidence.push(`曲线「${names.join("」「")}」的线型与标记均为 ${line}/${marker}，图面上无法区分`);
  }
  return evidence;
}

/** 图面词语（轴标目 + 图例文本）：供 V12/V13 的用语检查，只含**实际写上图面**的文本。 */
export function chartWordingLabels(chart: FigureChart | undefined): ChartLabel[] {
  const labels: ChartLabel[] = [];
  const xTitle = (chart?.x?.title ?? "").trim();
  const yTitle = (chart?.y?.title ?? "").trim();
  if (xTitle !== "") labels.push({ where: "横轴标目", text: xTitle });
  if (yTitle !== "") labels.push({ where: "纵轴标目", text: yTitle });
  if (chart?.legend !== false) {
    for (const series of seriesOf(chart)) {
      const name = series.name?.trim() ?? "";
      if (name !== "") labels.push({ where: "图例", text: name });
    }
  }
  return labels;
}

function finitePoints(series: ChartSeries): Point[] {
  const points: Point[] = [];
  for (const point of series.points ?? []) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }
  return points;
}

type Extent = { min: number; max: number };

/** 单根轴的范围与刻度值（范围与刻度同源：见 `axisTicks`）。 */
type AxisTicks = { range: [number, number]; values: number[] };

/** 浮点容差（步长整数倍的比较与取整：0.1 这类步长在二进制里不精确）。 */
const FLOAT_EPS = 1e-9;

/** 数据在某一维上的极值；无有效数据时返回 undefined。 */
function dataExtent(pointsBySeries: readonly Point[][], axis: "x" | "y"): Extent | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const points of pointsBySeries) {
    for (const point of points) {
      min = Math.min(min, point[axis]);
      max = Math.max(max, point[axis]);
    }
  }
  return min <= max ? { min, max } : undefined;
}

/** 取整步长：把原始步长抬到 1/2/2.5/5 × 10^n，使等距刻度落在整档上。 */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const multiple = NICE_MULTIPLES.find(candidate => normalized <= candidate + Number.EPSILON) ?? 10;
  return multiple * magnitude;
}

/** 刻度数：整数且落在 2..12，否则回落缺省（schema 的上下限只对模型起提示作用）。 */
function clampTickCount(requested: unknown): number {
  if (
    typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested >= MIN_TICK_COUNT &&
    requested <= MAX_TICK_COUNT
  ) {
    return requested;
  }
  return DEFAULT_TICK_COUNT;
}

/**
 * 轴范围与刻度值（同一处算定）。
 *
 * 刻度取整的要点：范围与刻度必须**同一条步长**决定——先按目标刻度数求步长
 * （1/2/2.5/5 × 10^n），再把缺省端取整到步长的整数倍，刻度就落在整数倍上；
 * 两者分开算会出现"范围取整到 [1,4] 而刻度按等距分割成 1/1.75/2.5/3.25/4"这类非整档标签。
 *
 * - 两端都缺省：数据极值向外取整（数据 0..96 配 5 个刻度 ⇒ 范围 [0, 100]、刻度 0/25/50/75/100）。
 *   **不做百分比外扩**：外扩会把"时间 0..4h"推成 -2..6h 这类含负值/超量的轴，读数反而失真。
 * - 显式端原样固定（调用方的取舍优先）：另一端按同一步长取整；两端都显式时该端可能不是步长
 *   的整数倍，此时该端没有刻度（轴仍结束在调用方给定的值上）。
 * - 实际刻度数由步长与范围共同决定，与目标刻度数可能不同（目标是"密度"而非硬性条数）。
 */
function axisTicks(axis: ChartAxis, extent: Extent | undefined, count: number): AxisTicks {
  const explicitMin = asFinite(axis.min);
  const explicitMax = asFinite(axis.max);
  let low = explicitMin ?? extent?.min ?? 0;
  let high = explicitMax ?? extent?.max ?? 1;
  if (!(high > low)) {
    const half = Math.abs(low) * 0.1 || 1;
    low -= half;
    high += half;
  }
  const step = niceStep((high - low) / (count - 1));
  const range: [number, number] = [
    explicitMin ?? Math.floor(low / step) * step,
    explicitMax ?? Math.ceil(high / step) * step,
  ];
  const values: number[] = [];
  for (
    let multiple = Math.ceil(range[0] / step - FLOAT_EPS);
    multiple * step <= range[1] + step * FLOAT_EPS;
    multiple += 1
  ) {
    values.push(multiple * step);
  }
  // 兜底：区间比步长还窄且不含任何整数倍时，退化为两端点（宁可两个刻度，不可零刻度）。
  if (values.length === 0) {
    values.push(range[0], range[1]);
  }
  return { range, values };
}

/** 各轴的实际范围与刻度（布局与 V21 共用同一判据，避免两处各算一遍而漂移）。 */
function axisTicksOf(
  chart: FigureChart | undefined,
  pointsBySeries: readonly Point[][],
  counts: { x: number; y: number },
): { x: AxisTicks; y: AxisTicks } {
  return {
    x: axisTicks(chart?.x ?? EMPTY_AXIS, dataExtent(pointsBySeries, "x"), counts.x),
    y: axisTicks(chart?.y ?? EMPTY_AXIS, dataExtent(pointsBySeries, "y"), counts.y),
  };
}

/**
 * 落在坐标轴范围之外的数据点（证据行；空数组=全部在范围内）。
 *
 * 轴外数据点会被画到绘图区之外（压住刻度值/标目），图面上看不出是缺陷 ⇒ 须显式报告；
 * 渲染器**不做裁剪**（裁剪等于把超范围的数据画成贴边，是更坏的失真）。
 */
export function chartOutOfRange(chart: FigureChart | undefined): string[] {
  const resolved = resolveChartSeries(chart);
  const pointsBySeries = resolved.map(entry => finitePoints(entry.series));
  const ranges = axisTicksOf(chart, pointsBySeries, {
    x: clampTickCount(chart?.x?.ticks),
    y: clampTickCount(chart?.y?.ticks),
  });
  const evidence: string[] = [];
  for (const [index, points] of pointsBySeries.entries()) {
    const name = resolved[index]!.series.name?.trim() || `第 ${index + 1} 条`;
    const outside = points.filter(
      point =>
        point.x < ranges.x.range[0] ||
        point.x > ranges.x.range[1] ||
        point.y < ranges.y.range[0] ||
        point.y > ranges.y.range[1],
    );
    if (outside.length === 0) continue;
    const sample = outside
      .slice(0, 3)
      .map(point => `(${fmtTick(point.x)}, ${fmtTick(point.y)})`)
      .join(" ");
    const suffix = outside.length > 3 ? ` 等 ${outside.length} 点` : "";
    evidence.push(
      `曲线「${name}」有数据点落在坐标轴范围外：${sample}${suffix}` +
        `（横轴 ${fmtTick(ranges.x.range[0])}..${fmtTick(ranges.x.range[1])}，` +
        `纵轴 ${fmtTick(ranges.y.range[0])}..${fmtTick(ranges.y.range[1])}）`,
    );
  }
  return evidence;
}

/** 图例按可用宽度折行（行内自左向右，超出换行）。 */
function packLegend(entries: readonly ResolvedChartSeries[], available: number): ResolvedChartSeries[][] {
  const rows: ResolvedChartSeries[][] = [];
  let row: ResolvedChartSeries[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const width = LEGEND_SWATCH_W + measureTextWidth(entry.series.name?.trim() ?? "");
    if (row.length > 0 && cursor + LEGEND_GAP_X + width > available) {
      rows.push(row);
      row = [];
      cursor = 0;
    }
    cursor += (row.length === 0 ? 0 : LEGEND_GAP_X) + width;
    row.push(entry);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * 曲线图布局：坐标轴几何、刻度落点、序列映射与图例折行。
 *
 * `caption: false` 时不留图号标注带（PCT/US 单幅不编号，画幅须与渲染器同源）。
 */
export function layoutChart(chart: FigureChart | undefined, options: { caption?: boolean } = {}): ChartLayout {
  const xAxis = chart?.x ?? EMPTY_AXIS;
  const yAxis = chart?.y ?? EMPTY_AXIS;
  const resolved = resolveChartSeries(chart);
  const pointsBySeries = resolved.map(entry => finitePoints(entry.series));
  const ticks = axisTicksOf(chart, pointsBySeries, {
    x: clampTickCount(xAxis.ticks),
    y: clampTickCount(yAxis.ticks),
  });
  const xValues = ticks.x.values;
  const yValues = ticks.y.values;
  const xTexts = xValues.map(fmtTick);
  const yTexts = yValues.map(fmtTick);

  // 左留纵轴刻度值与竖排标目，下留横轴刻度值、标目与图例：边距按实际文本宽度算，
  // 不写死常数（"-0.001" 与 "0" 的宽度差数倍，写死会让长刻度值压住纵轴标目）。
  const maxYLabelWidth = Math.max(0, ...yTexts.map(value => measureTextWidth(value)));
  const maxXLabelWidth = Math.max(0, ...xTexts.map(value => measureTextWidth(value)));
  const plotLeft = EDGE_PAD + FIGURE_FONT_SIZE + AXIS_TITLE_GAP + maxYLabelWidth + TICK_LABEL_GAP + AXIS_TICK;
  const plotRight = plotLeft + PLOT_WIDTH;
  const plotTop = EDGE_PAD;
  const plotBottom = plotTop + PLOT_HEIGHT;
  const xLabelBaseline = plotBottom + AXIS_TICK + TICK_LABEL_GAP + FIGURE_FONT_SIZE;
  const xTitleBaseline = xLabelBaseline + AXIS_TITLE_GAP + FIGURE_FONT_SIZE;

  const legendEntries =
    chart?.legend === false ? [] : resolved.filter(entry => (entry.series.name ?? "").trim() !== "");
  const rows = packLegend(legendEntries, plotRight - plotLeft);
  const legendTop = xTitleBaseline + AXIS_TITLE_GAP;
  const legend = rows.map((entries, rowIndex) => ({
    entries,
    baseline: legendTop + rowIndex * LEGEND_ROW_H + FIGURE_FONT_SIZE,
  }));
  const contentBottom = legend.length === 0 ? xTitleBaseline : legendTop + legend.length * LEGEND_ROW_H;

  const spanX = ticks.x.range[1] - ticks.x.range[0];
  const spanY = ticks.y.range[1] - ticks.y.range[0];
  const mapX = (value: number): number => plotLeft + ((value - ticks.x.range[0]) / spanX) * PLOT_WIDTH;
  const mapY = (value: number): number => plotBottom - ((value - ticks.y.range[0]) / spanY) * PLOT_HEIGHT;

  return {
    width: plotRight + EDGE_PAD + maxXLabelWidth / 2,
    height: contentBottom + EDGE_PAD + (options.caption === false ? 0 : CAPTION_H),
    plot: { left: plotLeft, top: plotTop, right: plotRight, bottom: plotBottom },
    grid: chart?.grid === true,
    xTitle: xAxis.title ?? "",
    yTitle: yAxis.title ?? "",
    xLabelBaseline,
    xTitleBaseline,
    yTitleX: plotLeft - AXIS_TICK - TICK_LABEL_GAP - maxYLabelWidth - AXIS_TITLE_GAP,
    xTicks: xTexts.map((text, index) => ({ text, position: mapX(xValues[index]!) })),
    yTicks: yTexts.map((text, index) => ({ text, position: mapY(yValues[index]!) })),
    series: resolved.map((entry, index) => ({
      resolved: entry,
      points: pointsBySeries[index]!.map(point => ({ x: mapX(point.x), y: mapY(point.y) })),
    })),
    legend,
  };
}

/** 线型 → `stroke-dasharray`（缺省实线）。 */
function dashArray(line: ChartLineStyle): string {
  if (line === "dashed") return ` stroke-dasharray="7 4"`;
  if (line === "dotted") return ` stroke-dasharray="1.5 3"`;
  return "";
}

function lineSegment(x1: number, y1: number, x2: number, y2: number, strokeWidth: number, dash = ""): string {
  return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="#000000" stroke-width="${strokeWidth}"${dash}/>`;
}

/** 文本元素：`rotated` 时绕锚点逆时针旋转 90°（纵轴标目自下而上）。 */
function text(x: number, y: number, content: string, anchor: "start" | "middle" | "end", rotated = false): string {
  const transform = rotated ? ` transform="rotate(-90 ${fmt(x)} ${fmt(y)})"` : "";
  return (
    `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${FIGURE_FONT_SIZE}" text-anchor="${anchor}"${transform} ` +
    `fill="#000000">${escapeXml(content)}</text>`
  );
}

/** 标记填充样式：空心（描边）与实心（黑底）。 */
const MARKER_OPEN = `fill="none" stroke="#000000" stroke-width="${SERIES_STROKE}"`;
const MARKER_FILLED = 'fill="#000000" stroke="#000000" stroke-width="1"';

/** 三角形标记的顶点外扩、底边下移与底边半宽（相对标记半径）。 */
const TRIANGLE_APEX_RATIO = 1.2;
const TRIANGLE_BASE_RATIO = 0.9;
const TRIANGLE_HALF_WIDTH_RATIO = 1.1;

function trianglePoints(cx: number, cy: number): string {
  const r = MARKER_RADIUS;
  return (
    `${fmt(cx)},${fmt(cy - r * TRIANGLE_APEX_RATIO)} ` +
    `${fmt(cx - r * TRIANGLE_HALF_WIDTH_RATIO)},${fmt(cy + r * TRIANGLE_BASE_RATIO)} ` +
    `${fmt(cx + r * TRIANGLE_HALF_WIDTH_RATIO)},${fmt(cy + r * TRIANGLE_BASE_RATIO)}`
  );
}

/** 标记形状绘制（Record 穷尽 ChartMarker：新增形状时编译期即报缺项）。 */
const MARKER_SHAPE: Readonly<Record<ChartMarker, (cx: number, cy: number) => string>> = {
  none: () => "",
  circle: (cx, cy) => `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${MARKER_RADIUS}" ${MARKER_OPEN}/>`,
  "filled-circle": (cx, cy) => `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${MARKER_RADIUS}" ${MARKER_FILLED}/>`,
  square: (cx, cy) =>
    `<rect x="${fmt(cx - MARKER_RADIUS)}" y="${fmt(cy - MARKER_RADIUS)}" width="${MARKER_RADIUS * 2}" height="${MARKER_RADIUS * 2}" ${MARKER_OPEN}/>`,
  "filled-square": (cx, cy) =>
    `<rect x="${fmt(cx - MARKER_RADIUS)}" y="${fmt(cy - MARKER_RADIUS)}" width="${MARKER_RADIUS * 2}" height="${MARKER_RADIUS * 2}" ${MARKER_FILLED}/>`,
  triangle: (cx, cy) => `<polygon points="${trianglePoints(cx, cy)}" ${MARKER_OPEN}/>`,
  "filled-triangle": (cx, cy) => `<polygon points="${trianglePoints(cx, cy)}" ${MARKER_FILLED}/>`,
  cross: (cx, cy) =>
    lineSegment(cx - MARKER_RADIUS, cy - MARKER_RADIUS, cx + MARKER_RADIUS, cy + MARKER_RADIUS, SERIES_STROKE) +
    lineSegment(cx - MARKER_RADIUS, cy + MARKER_RADIUS, cx + MARKER_RADIUS, cy - MARKER_RADIUS, SERIES_STROKE),
  plus: (cx, cy) =>
    lineSegment(cx - MARKER_RADIUS, cy, cx + MARKER_RADIUS, cy, SERIES_STROKE) +
    lineSegment(cx, cy - MARKER_RADIUS, cx, cy + MARKER_RADIUS, SERIES_STROKE),
};

/**
 * 绘制曲线图片段（不含 `<svg>` 根元素与图号——那两样由 `render-svg.ts` 统一加在图形正下方）。
 *
 * 观感：纵轴在左、横轴在下，轴端开口箭头；刻度线朝外、刻度值写在外侧；轴标目写在轴中部
 * （纵轴标目竖排）；多序列按标记与线型区分，图例列在横轴标目下方（不与数据区重叠）。
 */
export function renderChartBody(layout: ChartLayout): string {
  const { plot } = layout;
  const parts: string[] = [];

  if (layout.grid) {
    for (const tick of layout.xTicks) {
      parts.push(lineSegment(tick.position, plot.top, tick.position, plot.bottom, GRID_STROKE));
    }
    for (const tick of layout.yTicks) {
      parts.push(lineSegment(plot.left, tick.position, plot.right, tick.position, GRID_STROKE));
    }
  }

  // 轴线（L 形：纵轴在左、横轴在下）与轴端开口箭头。
  parts.push(lineSegment(plot.left, plot.top, plot.left, plot.bottom, AXIS_STROKE));
  parts.push(lineSegment(plot.left, plot.bottom, plot.right, plot.bottom, AXIS_STROKE));
  parts.push(lineSegment(plot.left, plot.top, plot.left - ARROW_HALF_WIDTH, plot.top + ARROW_LENGTH, AXIS_STROKE));
  parts.push(lineSegment(plot.left, plot.top, plot.left + ARROW_HALF_WIDTH, plot.top + ARROW_LENGTH, AXIS_STROKE));
  parts.push(
    lineSegment(plot.right, plot.bottom, plot.right - ARROW_LENGTH, plot.bottom - ARROW_HALF_WIDTH, AXIS_STROKE),
  );
  parts.push(
    lineSegment(plot.right, plot.bottom, plot.right - ARROW_LENGTH, plot.bottom + ARROW_HALF_WIDTH, AXIS_STROKE),
  );

  // 刻度线与刻度值（朝外，写在轴外侧）。
  for (const tick of layout.xTicks) {
    parts.push(lineSegment(tick.position, plot.bottom, tick.position, plot.bottom + AXIS_TICK, TICK_STROKE));
    parts.push(text(tick.position, layout.xLabelBaseline, tick.text, "middle"));
  }
  for (const tick of layout.yTicks) {
    parts.push(lineSegment(plot.left, tick.position, plot.left - AXIS_TICK, tick.position, TICK_STROKE));
    parts.push(
      text(plot.left - AXIS_TICK - TICK_LABEL_GAP, tick.position + FIGURE_FONT_SIZE * BASELINE_MID, tick.text, "end"),
    );
  }

  // 轴标目：横轴居中写在刻度值下方，纵轴竖排写在刻度值左侧。
  if (layout.xTitle.trim() !== "") {
    parts.push(text((plot.left + plot.right) / 2, layout.xTitleBaseline, layout.xTitle, "middle"));
  }
  if (layout.yTitle.trim() !== "") {
    parts.push(text(layout.yTitleX, plot.top + PLOT_HEIGHT / 2, layout.yTitle, "middle", true));
  }

  for (const entry of layout.series) {
    const { resolved, points } = entry;
    if (points.length > 1) {
      parts.push(
        `<polyline fill="none" stroke="#000000" stroke-width="${SERIES_STROKE}"${dashArray(resolved.line)} ` +
          `points="${points.map(point => `${fmt(point.x)},${fmt(point.y)}`).join(" ")}"/>`,
      );
    }
    for (const point of points) {
      parts.push(MARKER_SHAPE[resolved.marker](point.x, point.y));
    }
  }

  // 图例：示例线段带序列的线型，其上叠序列的标记（线型与标记两维都在图例里体现）。
  for (const row of layout.legend) {
    let cursor = plot.left;
    for (const entry of row.entries) {
      const name = entry.series.name?.trim() ?? "";
      const centerY = row.baseline - FIGURE_FONT_SIZE * BASELINE_MID;
      parts.push(lineSegment(cursor, centerY, cursor + LEGEND_SWATCH_W, centerY, SERIES_STROKE, dashArray(entry.line)));
      parts.push(MARKER_SHAPE[entry.marker](cursor + LEGEND_SWATCH_W / 2, centerY));
      parts.push(text(cursor + LEGEND_SWATCH_W + TICK_LABEL_GAP, row.baseline, name, "start"));
      cursor += LEGEND_SWATCH_W + TICK_LABEL_GAP + measureTextWidth(name) + LEGEND_GAP_X;
    }
  }

  return parts.filter(part => part !== "").join("\n");
}
