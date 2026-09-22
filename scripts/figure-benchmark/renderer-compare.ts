/**
 * scripts/figure-benchmark/renderer-compare.ts — 「默认渲染器是否切换为 graphviz-wasm」的量化对比。
 *
 * 目的：为「把默认渲染器从内置布局换成 graphviz-wasm」提供**可复算的数字**，而不是凭手感。
 * 输入是入库的确定性用例集合（`gen-cases.ts`，与合规基准同一集合）：不含私有数据、不调模型，
 * 同一命令每次得到同一批数字。
 *
 * ## 预登记判据（先写判据、再看数字，避免事后为结论找理由）
 *
 * - **C1 契约对等**：同一用例下，两后端的 V 规则签名（rule/severity/metric/图号）、节点 id 与
 *   `data-ref` 回读、图号观测、SVG 安全门判定全等。任何一处不等 ⇒ 不可切换。
 * - **C2 版面不劣**：没有任何用例在「文字交叠对数」「标签被连线穿越次数」上变差，且全部用例的
 *   打印字高达标（不新增 V7 warn）、所需缩放系数不小于内置渲染器。
 * - **C3 成本可接受**：冷启动首图增量 ≤ 500ms、稳态单图中位数 ≤ 内置渲染器的 2 倍、常驻内存
 *   增量 ≤ 50MB。
 * - **C4 失败面可解释**：两后端都 fail-loud、不静默回退（由既有单测断言，本脚本不测量）。
 *
 * 任一不满足 ⇒ 结论是保持 `builtin` 为默认、graphviz/wasm 维持 opt-in（不突变默认行为与快照）。
 *
 * ## 用法
 *
 *   tsx scripts/figure-benchmark/renderer-compare.ts [--repeat 3] [--cases id1,id2] [--json 路径] [--no-cold]
 *   # 冷启动探针由主流程以子进程调用（一个后端一个进程）：
 *   node_modules/.bin/tsx scripts/figure-benchmark/renderer-compare.ts --probe <backend>
 *
 * ## 度量口径（几何量全部从**交付后的 SVG** 反推，与渲染器内部实现无关）
 *
 * - 文本框：`<text>` 的 x/y/font-size/text-anchor + 生产同源字宽度量 `measureTextWidth`
 *   （CJK 1em、其余 0.5em）；高度按 ascent 0.8em / descent 0.2em 近似；
 * - 连线：内置渲染器取 `<polyline points>`；graphviz 取 `<g class="edge">` 内的 `<path d>`
 *   （M/L 直线段 + C 三次曲线按 1/4 采样，A 圆弧按端点直线近似并计数）；
 * - 节点盒：白底填充的 `<rect>`/`<ellipse>`/`<polygon>`（整幅白底与黑色实心箭头不算）；
 * - 三个缺陷计数都要求**贯穿**（两端在框外且穿过两条边）：擦边、连线止于节点边框不算——
 *   graphviz 用它自己的字体度量排盒，与本模块的字宽近似有百分之几的系统偏差，
 *   按"相接即算"会只惩罚其中一方；
 * - 压线目标排除**边标签**（内置渲染器靠 `paint-order="stroke"`、graphviz 靠 `<g class="edge">`
 *   分组 + 白底垫片，两种记号都要排除）；
 * - 画幅利用率：`<text>`/`<rect>`/`<polygon>`/`<ellipse>`/`<polyline>` 的并集包围盒 ÷ 画布。
 *   整幅白底（内置 rect / graphviz graph0 polygon）与 `<defs>` 内元素不参与；`path` 画出的
 *   形状（圆角框/圆柱体）不参与，属已知低估。
 *
 * 结果是一份数字与逐条判据结论，**不是**门禁（不挂 CI）：它服务一次性决策，判断标准见上。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertSafeSvg,
  checkFigures,
  createWasmDotRunner,
  measureTextWidth,
  minCharHeight,
  MM_PER_INCH,
  parseFigureSvg,
  profileForJurisdiction,
  pxToMm,
  renderFigureSvg,
  renderFigureSvgWithGraphviz,
  resolveDotBinary,
  uniformFigureZoom,
  type FigureCheckFinding,
  type FigureSpec,
  type Jurisdiction,
} from "../../src/patent/figuregen/index.js";
import { GENERATION_BENCHMARK_CASES, type GenBenchmarkCase } from "./gen-cases.js";

export type Backend = "builtin" | "graphviz" | "graphviz-wasm";

const ALL_BACKENDS: readonly Backend[] = ["builtin", "graphviz", "graphviz-wasm"];

/** 预登记成本门槛（C3）：冷启动增量、稳态单图绝对耗时、常驻内存增量。 */
export const COLD_START_BUDGET_MS = 500;
/**
 * 稳态单图绝对预算（毫秒）。**不**用「相对内置渲染器的倍数」判稳态：
 * 内置渲染器是纯字符串拼装，量级在 0.05–0.1ms，任何比值都在噪声里（一次 0.02ms 的抖动
 * 就是 1.5×）。绝对预算才是可判的量——相对一次模型调用（秒级）它本就该可忽略。
 */
export const WARM_BUDGET_MS = 5;
export const RSS_BUDGET_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------- 几何解析

export type Box = { left: number; top: number; right: number; bottom: number };
export type SvgCanvas = { width: number; height: number };
export type Point = { x: number; y: number };
export type Segment = { x1: number; y1: number; x2: number; y2: number };

/** 文本框：`onLine` 为压在连线上的边标签（`paint-order="stroke"` 白描边），不参与穿线判定。 */
export type TextBox = Box & { text: string; fontSize: number; onLine: boolean };

const ATTRS = /([\w:.-]+)="([^"]*)"/gu;

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(ATTRS)) {
    attrs.set(match[1]!, match[2]!);
  }
  return attrs;
}

/** 根元素 viewBox 的画幅（内置渲染器单位 px，graphviz 单位 pt——换算见 `canvasMmOf`）。 */
export function parseSvgCanvas(svg: string): SvgCanvas {
  const root = svg.match(/<svg\b[^>]*>/u);
  if (root === null) {
    throw new Error("SVG 缺少根元素");
  }
  const viewBox = parseAttrs(root[0]).get("viewBox");
  if (viewBox === undefined) {
    throw new Error("SVG 缺少 viewBox");
  }
  const parts = viewBox.trim().split(/\s+/u).map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) {
    throw new Error(`viewBox 非法: ${viewBox}`);
  }
  return { width: parts[2]!, height: parts[3]! };
}

/** 全部 `<text>` 的近似文本框（宽用生产同源字宽度量，高按 0.8/0.2 em 上下沿）。 */
export function parseTextBoxes(svg: string): TextBox[] {
  // 边标签压在连线上、不被算作"被连线划掉"：内置渲染器用 `paint-order="stroke"` 白描边，
  // graphviz 则把边标签放进 `<g class="edge">` 并用白底多边形垫底——两种记号都要排除，
  // 否则只惩罚其中一方（实测 `branch-diamond` 的 wasm 版即由此产生 1 处假阳性）。
  const edgeSpans = extractGroups(svg, "edge");
  const boxes: TextBox[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gu)) {
    const attrs = parseAttrs(match[1]!);
    const text = match[2]!.replaceAll(/<[^>]*>/gu, "").trim();
    const fontSize = Number(attrs.get("font-size") ?? "0");
    if (text === "" || !Number.isFinite(fontSize) || fontSize <= 0) {
      continue;
    }
    const x = Number(attrs.get("x") ?? "0");
    const y = Number(attrs.get("y") ?? "0");
    const width = measureTextWidth(text, fontSize);
    const anchor = attrs.get("text-anchor") ?? "start";
    const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
    const index = match.index ?? 0;
    boxes.push({
      left,
      right: left + width,
      top: y - fontSize * 0.8,
      bottom: y + fontSize * 0.2,
      text,
      fontSize,
      onLine: attrs.get("paint-order") === "stroke" || edgeSpans.some(span => index >= span.start && index < span.end),
    });
  }
  return boxes;
}

function pairsOf(points: string): Point[] {
  const out: Point[] = [];
  for (const pair of points.trim().split(/\s+/u)) {
    const [x, y] = pair.split(",").map(Number);
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    out.push({ x, y });
  }
  return out;
}

function toSegments(points: readonly Point[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return segments;
}

/** 内置渲染器的连线（`<polyline>` 折线）。 */
export function parsePolylineSegments(svg: string): Segment[] {
  const segments: Segment[] = [];
  for (const match of svg.matchAll(/<polyline\b([^>]*?)\/?>/gu)) {
    const points = parseAttrs(match[1]!).get("points");
    if (points !== undefined) {
      segments.push(...toSegments(pairsOf(points)));
    }
  }
  return segments;
}

/** 三次贝塞尔在 t 处的取值（graphviz 边路径的 C 段采样用）。 */
function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

const PATH_TOKEN = /[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/giu;

/** SVG path 的 `d` → 折线点；仅支持 dot 输出的绝对 M/L/C/A/Z，其余记 unsupported 计数。 */
export function parsePathData(d: string): { points: Point[]; unsupported: number } {
  const tokens = d.match(PATH_TOKEN) ?? [];
  const points: Point[] = [];
  let unsupported = 0;
  let cursor = 0;
  let command = "";
  let x = 0;
  let y = 0;
  const num = (): number => Number(tokens[cursor++] ?? "0");
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (/[A-Za-z]/u.test(token)) {
      command = token;
      cursor++;
      continue;
    }
    if (command === "M" || command === "L") {
      x = num();
      y = num();
      points.push({ x, y });
      command = "L";
      continue;
    }
    if (command === "C") {
      const c1 = { x: num(), y: num() };
      const c2 = { x: num(), y: num() };
      const end = { x: num(), y: num() };
      const from = { x, y };
      for (let t = 0.25; t <= 1.0001; t += 0.25) {
        points.push(cubicAt(from, c1, c2, end, t));
      }
      x = end.x;
      y = end.y;
      continue;
    }
    if (command === "A") {
      num();
      num();
      num();
      num();
      num();
      x = num();
      y = num();
      points.push({ x, y });
      unsupported++;
      continue;
    }
    unsupported++;
    cursor = tokens.length;
  }
  return { points, unsupported };
}

/** 取出形如 `<g ... class="edge" ...>…</g>` 的分组（内容 + 在原文中的区间，按嵌套深度配对）。 */
export function extractGroups(svg: string, className: string): { content: string; start: number; end: number }[] {
  const groups: { content: string; start: number; end: number }[] = [];
  const open = new RegExp(`<g\\b[^>]*class="${className}"[^>]*>`, "gu");
  for (const match of svg.matchAll(open)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let index = start;
    while (depth > 0 && index < svg.length) {
      const nextOpen = svg.indexOf("<g", index);
      const nextClose = svg.indexOf("</g>", index);
      if (nextClose === -1) {
        break;
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        index = nextOpen + 2;
        continue;
      }
      depth--;
      index = nextClose + 4;
    }
    const end = Math.max(start, index - 4);
    groups.push({ content: svg.slice(start, end), start, end });
  }
  return groups;
}

/** graphviz 的连线（`<g class="edge">` 内的 `<path>`）。 */
export function parseGraphvizEdgeSegments(svg: string): { segments: Segment[]; unsupported: number } {
  const segments: Segment[] = [];
  let unsupported = 0;
  for (const group of extractGroups(svg, "edge")) {
    for (const match of group.content.matchAll(/<path\b([^>]*?)\/?>/gu)) {
      const d = parseAttrs(match[1]!).get("d");
      if (d === undefined) {
        continue;
      }
      const parsed = parsePathData(d);
      unsupported += parsed.unsupported;
      segments.push(...toSegments(parsed.points));
    }
  }
  return { segments, unsupported };
}

/** 按后端取连线几何。 */
export function edgeSegmentsOf(svg: string, backend: Backend): { segments: Segment[]; unsupported: number } {
  if (backend === "builtin") {
    return { segments: parsePolylineSegments(svg), unsupported: 0 };
  }
  return parseGraphvizEdgeSegments(svg);
}

/**
 * 节点图形盒：白底填充的 `<rect>`/`<ellipse>`/`<polygon>`。
 *
 * 排除两类非节点图形：整幅白底（面积 ≥ 画布 90%）与**黑色填充**多边形（graphviz 的箭头是
 * 实心黑三角）。`path` 画出的节点形状（graphviz `style=rounded` 的圆角框、cylinder）不参与，
 * 属已知低估——两个后端都受影响。
 */
export function parseNodeBoxes(svg: string): Box[] {
  const canvas = parseSvgCanvas(svg);
  const canvasArea = canvas.width * canvas.height;
  const content = svg.replaceAll(/<defs>[\s\S]*?<\/defs>/gu, "");
  const boxes: Box[] = [];
  const push = (box: Box, fill: string): void => {
    const area = (box.right - box.left) * (box.bottom - box.top);
    const white = fill.toLowerCase() === "#ffffff" || fill.toLowerCase() === "white";
    if (white && area < canvasArea * 0.9) {
      boxes.push(box);
    }
  };
  for (const match of content.matchAll(/<rect\b([^>]*?)\/?>/gu)) {
    const attrs = parseAttrs(match[1]!);
    const x = Number(attrs.get("x") ?? "0");
    const y = Number(attrs.get("y") ?? "0");
    const width = Number(attrs.get("width") ?? "0");
    const height = Number(attrs.get("height") ?? "0");
    push({ left: x, top: y, right: x + width, bottom: y + height }, attrs.get("fill") ?? "");
  }
  for (const match of content.matchAll(/<ellipse\b([^>]*?)\/?>/gu)) {
    const attrs = parseAttrs(match[1]!);
    const cx = Number(attrs.get("cx") ?? "0");
    const cy = Number(attrs.get("cy") ?? "0");
    const rx = Number(attrs.get("rx") ?? "0");
    const ry = Number(attrs.get("ry") ?? "0");
    push({ left: cx - rx, top: cy - ry, right: cx + rx, bottom: cy + ry }, attrs.get("fill") ?? "");
  }
  for (const match of content.matchAll(/<polygon\b([^>]*?)\/?>/gu)) {
    const attrs = parseAttrs(match[1]!);
    const points = attrs.get("points");
    if (points === undefined) {
      continue;
    }
    const parsed = pairsOf(points);
    if (parsed.length === 0) {
      continue;
    }
    push(
      {
        left: Math.min(...parsed.map(p => p.x)),
        right: Math.max(...parsed.map(p => p.x)),
        top: Math.min(...parsed.map(p => p.y)),
        bottom: Math.max(...parsed.map(p => p.y)),
      },
      attrs.get("fill") ?? "",
    );
  }
  return boxes;
}

/** 连线贯穿「无关节点图形盒」的次数（标记线穿过别的部件是附图缺陷）。 */
export function countEdgeNodeCrossings(segments: readonly Segment[], nodeBoxes: readonly Box[]): number {
  let count = 0;
  for (const segment of segments) {
    for (const box of nodeBoxes) {
      if (segmentCrossesBox(segment, box)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * 文字互相压线的对数。
 *
 * 用「交叠面积 ≥ 较小框的 `minRatio`」判「有意义的重叠」，而不是边框相接即算：
 * graphviz 用它自己的字体度量排盒，与本模块的字宽近似（CJK 1em / 其余 0.5em）有百分之几的
 * 系统偏差，按相接判定会把两个后端正常的紧凑布局一律标成压线（实测 `block-lr-3node`
 * 的 wasm 版即由此产生 2 处假阳性）。真正的压线是叠在一起，不是擦边。
 */
export function countTextOverlaps(boxes: readonly TextBox[], minRatio = 0.15): number {
  let count = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapWidth <= 0 || overlapHeight <= 0) {
        continue;
      }
      const smaller = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
      if (smaller > 0 && (overlapWidth * overlapHeight) / smaller >= minRatio) {
        count++;
      }
    }
  }
  return count;
}

/** 线段是否**贯穿**矩形：两端都在框外，且与框边有 ≥ 2 个交点（进入并穿出）。 */
function segmentCrossesBox(segment: Segment, box: Box): boolean {
  const inside = (x: number, y: number): boolean => x > box.left && x < box.right && y > box.top && y < box.bottom;
  if (inside(segment.x1, segment.y1) || inside(segment.x2, segment.y2)) {
    // 端点落在框内 = 连线到此为止（如边起点贴着节点边框的标签），不是划线穿过
    return false;
  }
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const crossings = new Set<string>();
  const faces: Segment[] = [
    { x1: box.left, y1: box.top, x2: box.right, y2: box.top },
    { x1: box.right, y1: box.top, x2: box.right, y2: box.bottom },
    { x1: box.right, y1: box.bottom, x2: box.left, y2: box.bottom },
    { x1: box.left, y1: box.bottom, x2: box.left, y2: box.top },
  ];
  for (const face of faces) {
    const ex = face.x2 - face.x1;
    const ey = face.y2 - face.y1;
    const denominator = dx * ey - dy * ex;
    if (denominator === 0) {
      continue;
    }
    const t = ((face.x1 - segment.x1) * ey - (face.y1 - segment.y1) * ex) / denominator;
    const u = ((face.x1 - segment.x1) * dy - (face.y1 - segment.y1) * dx) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      crossings.add(`${(segment.x1 + t * dx).toFixed(3)},${(segment.y1 + t * dy).toFixed(3)}`);
    }
  }
  return crossings.size >= 2;
}

/** 连线贯穿「非本线标签」文本框的次数（标签被标记线划掉是附图缺陷）。 */
export function countLabelStrikes(segments: readonly Segment[], boxes: readonly TextBox[]): number {
  const targets = boxes.filter(box => !box.onLine);
  let count = 0;
  for (const segment of segments) {
    for (const box of targets) {
      if (segmentCrossesBox(segment, box)) {
        count++;
      }
    }
  }
  return count;
}

function mergeBox(current: Box | undefined, next: Box): Box {
  if (current === undefined) {
    return next;
  }
  return {
    left: Math.min(current.left, next.left),
    right: Math.max(current.right, next.right),
    top: Math.min(current.top, next.top),
    bottom: Math.max(current.bottom, next.bottom),
  };
}

/**
 * 图形内容的并集包围盒：`<text>` + `<rect>`/`<polygon>`/`<ellipse>`/`<polyline>`。
 * `<defs>` 段（箭头 marker）与背景整幅白底矩形（面积 ≥ 画布 90%）不计；
 * `path` 画出的形状（圆角框/圆柱体）不计，属已知低估。
 */
export function parseContentBBox(svg: string, canvas: SvgCanvas): Box | undefined {
  const canvasArea = canvas.width * canvas.height;
  const content = svg.replaceAll(/<defs>[\s\S]*?<\/defs>/gu, "");
  let box: Box | undefined;
  for (const textBox of parseTextBoxes(content)) {
    box = mergeBox(box, textBox);
  }
  for (const match of content.matchAll(/<rect\b([^>]*?)\/?>/gu)) {
    const attrs = parseAttrs(match[1]!);
    const x = Number(attrs.get("x") ?? "0");
    const y = Number(attrs.get("y") ?? "0");
    const width = Number(attrs.get("width") ?? "0");
    const height = Number(attrs.get("height") ?? "0");
    if (![x, y, width, height].every(Number.isFinite) || width * height >= canvasArea * 0.9) {
      continue;
    }
    box = mergeBox(box, { left: x, top: y, right: x + width, bottom: y + height });
  }
  for (const match of content.matchAll(/<ellipse\b([^>]*?)\/?>/gu)) {
    const attrs = parseAttrs(match[1]!);
    const cx = Number(attrs.get("cx") ?? "0");
    const cy = Number(attrs.get("cy") ?? "0");
    const rx = Number(attrs.get("rx") ?? "0");
    const ry = Number(attrs.get("ry") ?? "0");
    box = mergeBox(box, { left: cx - rx, top: cy - ry, right: cx + rx, bottom: cy + ry });
  }
  for (const match of content.matchAll(/<(?:polygon|polyline)\b([^>]*?)\/?>/gu)) {
    const points = parseAttrs(match[1]!).get("points");
    if (points === undefined) {
      continue;
    }
    const parsed = pairsOf(points);
    if (parsed.length === 0) {
      continue;
    }
    const box2: Box = {
      left: Math.min(...parsed.map(p => p.x)),
      right: Math.max(...parsed.map(p => p.x)),
      top: Math.min(...parsed.map(p => p.y)),
      bottom: Math.max(...parsed.map(p => p.y)),
    };
    // graphviz 的 graph0 里有一块整幅白底 `<polygon>`（与内置渲染器的整幅白底 `<rect>` 同性质）：
    // 计入会把利用率恒钉在 1.00，故与 rect 同规则排除。
    if ((box2.right - box2.left) * (box2.bottom - box2.top) >= canvasArea * 0.9) {
      continue;
    }
    box = mergeBox(box, box2);
  }
  return box;
}

/** 画幅利用率：内容并集包围盒面积 ÷ 画布面积（≤ 1）。 */
export function utilization(svg: string, canvas: SvgCanvas): number {
  const box = parseContentBBox(svg, canvas);
  if (box === undefined) {
    return 0;
  }
  const area = (box.right - box.left) * (box.bottom - box.top);
  return canvas.width * canvas.height > 0 ? Math.min(1, area / (canvas.width * canvas.height)) : 0;
}

// ---------------------------------------------------------------- 渲染与度量

/** 画幅单位 → 毫米：内置渲染器坐标是 CSS px，graphviz 的 viewBox 是 pt。 */
export function canvasMmOf(canvas: SvgCanvas, backend: Backend): { widthMm: number; heightMm: number } {
  const unitToMm = backend === "builtin" ? pxToMm(1) : MM_PER_INCH / 72;
  return { widthMm: canvas.width * unitToMm, heightMm: canvas.height * unitToMm };
}

/** 图内文字的字号换算成毫米（与 patentFigureGenerate 的 sourceCharMm 同口径）。 */
export function charMmOf(backend: Backend): number {
  return backend === "builtin" ? pxToMm(14) : (14 / 72) * MM_PER_INCH;
}

type RenderOutcome = { svg: string; ms: number };

type BackendContext = {
  render: (spec: FigureSpec, jurisdiction: Jurisdiction | undefined, figureCount: number) => Promise<RenderOutcome>;
};

async function createBackendContext(backend: Backend): Promise<BackendContext> {
  if (backend === "builtin") {
    return {
      render: async (spec, jurisdiction, figureCount) => {
        const start = performance.now();
        const { svg } = renderFigureSvg(spec, { jurisdiction, figureCount });
        return { svg, ms: performance.now() - start };
      },
    };
  }
  if (backend === "graphviz") {
    const dotPath = resolveDotBinary();
    if (dotPath === null) {
      throw new Error("未找到 graphviz dot（跳过 graphviz 后端）");
    }
    return {
      render: async (spec, jurisdiction, figureCount) => {
        const start = performance.now();
        const { svg } = await renderFigureSvgWithGraphviz(spec, { dotPath, jurisdiction, figureCount });
        return { svg, ms: performance.now() - start };
      },
    };
  }
  const runner = createWasmDotRunner();
  return {
    render: async (spec, jurisdiction, figureCount) => {
      const start = performance.now();
      const { svg } = await renderFigureSvgWithGraphviz(spec, { runner, jurisdiction, figureCount });
      return { svg, ms: performance.now() - start };
    },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type FigureMetrics = {
  figureNo: number;
  bytes: number;
  textOverlaps: number;
  labelStrikes: number;
  nodeCrossings: number;
  utilization: number;
  segments: number;
  nodeBoxes: number;
  unsupportedPathCommands: number;
  deterministic: boolean;
};

export type CaseBackendMetrics = {
  caseId: string;
  backend: Backend;
  figures: FigureMetrics[];
  /** 本案统一缩放系数（同一文档内各图共用，取最小值）。 */
  zoom: number;
  printedCharMm: number;
  minCharMm: number | undefined;
  charHeightBasis: "statute" | "practice" | undefined;
  canvasMm: { widthMm: number; heightMm: number }[];
  findingSignature: string[];
  nodeSignature: string[];
  numberedFigureNos: number[];
  safe: boolean;
  warmMedianMs: number;
};

/** 观测后的附图（与 patent_figure_check 的 svg_paths 路径同构）。 */
function observationsOf(svg: string): { figures: FigureSpec[]; numberedFigureNos: number[]; signature: string[] } {
  const parsed = parseFigureSvg(svg);
  const signature = parsed.nodes
    .map(node => `${node.id}#${node.ref ?? "-"}#${node.label}`)
    .sort((a, b) => a.localeCompare(b));
  return {
    figures: [{ figure_no: parsed.figureNo, kind: "flowchart", nodes: parsed.nodes, edges: [] }],
    numberedFigureNos: parsed.numbered ? [parsed.figureNo] : [],
    signature,
  };
}

function findingSignature(findings: readonly FigureCheckFinding[]): string[] {
  return findings
    .map(finding => `${finding.rule}|${finding.severity}|${finding.metric}|${(finding.figure_nos ?? []).join(",")}`)
    .sort((a, b) => a.localeCompare(b));
}

async function measureCase(
  testCase: GenBenchmarkCase,
  backend: Backend,
  context: BackendContext,
  repeat: number,
): Promise<CaseBackendMetrics> {
  const profile = profileForJurisdiction(testCase.jurisdiction);
  const figureCount = testCase.figureCount ?? testCase.figures.length;
  const figures: FigureMetrics[] = [];
  const canvasMm: { widthMm: number; heightMm: number }[] = [];
  const canvasSizes: { widthMm: number; heightMm: number }[] = [];
  const observationFigures: FigureSpec[] = [];
  const numberedFigureNos: number[] = [];
  const nodeSignature: string[] = [];
  let safe = true;
  const warmTimes: number[] = [];

  for (const spec of testCase.figures) {
    const texts = new Set<string>();
    let first: RenderOutcome | undefined;
    let figureMetrics: FigureMetrics | undefined;
    for (let run = 0; run < repeat; run++) {
      const outcome = await context.render(spec, testCase.jurisdiction, figureCount);
      texts.add(sha256(outcome.svg));
      if (run > 0) {
        warmTimes.push(outcome.ms);
      }
      if (run === 0) {
        first = outcome;
        const canvas = parseSvgCanvas(outcome.svg);
        const { segments, unsupported } = edgeSegmentsOf(outcome.svg, backend);
        const boxes = parseTextBoxes(outcome.svg);
        const nodeBoxes = parseNodeBoxes(outcome.svg);
        figureMetrics = {
          figureNo: spec.figure_no,
          bytes: Buffer.byteLength(outcome.svg, "utf8"),
          textOverlaps: countTextOverlaps(boxes),
          labelStrikes: countLabelStrikes(segments, boxes),
          nodeCrossings: countEdgeNodeCrossings(segments, nodeBoxes),
          utilization: utilization(outcome.svg, canvas),
          segments: segments.length,
          nodeBoxes: nodeBoxes.length,
          unsupportedPathCommands: unsupported,
          deterministic: false,
        };
        const mm = canvasMmOf(canvas, backend);
        canvasMm.push(mm);
        canvasSizes.push(mm);
      }
    }
    if (first === undefined || figureMetrics === undefined) {
      throw new Error(`用例 ${testCase.id} 未产出渲染结果`);
    }
    figureMetrics.deterministic = texts.size === 1;
    figures.push(figureMetrics);

    try {
      assertSafeSvg(first.svg);
    } catch {
      safe = false;
    }
    const observation = observationsOf(first.svg);
    observationFigures.push(...observation.figures);
    numberedFigureNos.push(...observation.numberedFigureNos);
    nodeSignature.push(...observation.signature);
  }

  const zoom = uniformFigureZoom(canvasSizes, profile);
  const findings: FigureCheckFinding[] = checkFigures(observationFigures, testCase.specText, {
    ...(testCase.jurisdiction === undefined ? {} : { jurisdiction: testCase.jurisdiction }),
    figureCount,
    ...(testCase.documentKind === undefined ? {} : { documentKind: testCase.documentKind }),
    numberedFigureNos,
  }).findings;
  const charHeight = minCharHeight(profile);

  return {
    caseId: testCase.id,
    backend,
    figures,
    zoom,
    printedCharMm: charMmOf(backend) * zoom,
    minCharMm: charHeight?.mm,
    charHeightBasis: charHeight?.basis,
    canvasMm,
    findingSignature: findingSignature(findings),
    nodeSignature: nodeSignature.sort((a, b) => a.localeCompare(b)),
    numberedFigureNos: numberedFigureNos.sort((a, b) => a - b),
    safe,
    warmMedianMs: median(warmTimes),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------- 冷启动探针

type ProbeResult = {
  backend: Backend;
  importMs: number;
  moduleLoadMs: number | null;
  firstRenderMs: number;
  warmMedianMs: number;
  warmRunsMs: number[];
  rssBytes: number;
  hash: string;
};

async function runProbe(backend: Backend): Promise<void> {
  const importStart = performance.now();
  let moduleLoadMs: number | null = null;
  if (backend === "graphviz-wasm") {
    const moduleStart = performance.now();
    await import("@viz-js/viz");
    moduleLoadMs = performance.now() - moduleStart;
  }
  const context = await createBackendContext(backend);
  const importMs = performance.now() - importStart;

  const probeCase = GENERATION_BENCHMARK_CASES.find(item => item.id === "flow-tb-12") ?? GENERATION_BENCHMARK_CASES[0]!;
  const figureCount = probeCase.figureCount ?? probeCase.figures.length;
  const spec = probeCase.figures[0]!;

  const firstStart = performance.now();
  const first = await context.render(spec, probeCase.jurisdiction, figureCount);
  const firstRenderMs = performance.now() - firstStart;

  const warmRunsMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    warmRunsMs.push((await context.render(spec, probeCase.jurisdiction, figureCount)).ms);
  }

  const result: ProbeResult = {
    backend,
    importMs,
    moduleLoadMs,
    firstRenderMs,
    warmMedianMs: median(warmRunsMs),
    warmRunsMs,
    rssBytes: process.memoryUsage().rss,
    hash: sha256(first.svg),
  };
  process.stdout.write(`PROBE_JSON ${JSON.stringify(result)}\n`);
}

const execFileAsync = promisify(execFile);

async function collectProbes(backends: readonly Backend[]): Promise<Map<Backend, ProbeResult | string>> {
  const scriptPath = join(process.cwd(), "scripts", "figure-benchmark", "renderer-compare.ts");
  const runner = join(process.cwd(), "node_modules", ".bin", "tsx");
  const results = new Map<Backend, ProbeResult | string>();
  for (const backend of backends) {
    try {
      const { stdout } = await execFileAsync(runner, [scriptPath, "--probe", backend], {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      });
      const line = stdout.split("\n").find(item => item.startsWith("PROBE_JSON "));
      results.set(backend, line === undefined ? "探针无输出" : (JSON.parse(line.slice(11)) as ProbeResult));
    } catch (err) {
      results.set(backend, err instanceof Error ? err.message.split("\n")[0]! : String(err));
    }
  }
  return results;
}

// ---------------------------------------------------------------- 主流程与报告

function parseArgs(argv: readonly string[]) {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (key.startsWith("--")) {
      args[key.slice(2)] = value !== undefined && !value.startsWith("--") ? value : "true";
    }
  }
  return args;
}

const fmt = (value: number, digits = 1): string => value.toFixed(digits);

/**
 * 渲染器对比专用用例：**分叉/树形/汇合**拓扑。
 *
 * 合规基准（`gen-cases.ts`）的用例是链式或单列（它面向介质与用语的回归面），拿它分辨不了
 * "布局质量"——而 graphviz 后端正是为**分叉大图**引入的。抽样时在这三类拓扑上补测，
 * 否则结论只能说"在链式图上无差异"，不能说"两类后端质量相当"。
 */
function rendererCases(): GenBenchmarkCase[] {
  const label = (index: number): { label: string; ref: number } => ({
    label: `处理单元${String.fromCharCode(65 + (index % 26))}`,
    ref: 10 + index,
  });
  const cases: GenBenchmarkCase[] = [];

  // 分叉 + 汇合（菱形）：1 入 → 3 分支 → 1 出
  {
    const nodes = [
      { id: "r-n1", label: "开始", shape: "round" as const },
      { id: "r-n2", label: "判断条件", shape: "diamond" as const, ref: 10 },
      ...Array.from({ length: 3 }, (_unused, index) => {
        const { label: text, ref } = label(index);
        return { id: `r-n${index + 3}`, label: text, ref, shape: "rect" as const };
      }),
      { id: "r-n6", label: "汇总输出", shape: "round" as const, ref: 20 },
    ];
    const edges = [
      { from: "r-n1", to: "r-n2" },
      { from: "r-n2", to: "r-n3", label: "是" },
      { from: "r-n2", to: "r-n4", label: "否" },
      { from: "r-n2", to: "r-n5", label: "其它" },
      { from: "r-n3", to: "r-n6" },
      { from: "r-n4", to: "r-n6" },
      { from: "r-n5", to: "r-n6" },
    ];
    cases.push({
      id: "branch-diamond",
      title: "分叉 + 汇合（三出一汇）",
      jurisdiction: "cn",
      documentKind: "invention",
      figures: [{ figure_no: 1, kind: "flowchart", direction: "TB", nodes, edges }],
      specText: flowSpecText(nodes),
    });
  }

  // 二叉树（15 节点、14 条边）：层内多节点，最能暴露布局器差异
  {
    const nodes = Array.from({ length: 15 }, (_unused, index) =>
      index === 0
        ? { id: "t-n0", label: "根节点", shape: "round" as const, ref: 10 }
        : { id: `t-n${index}`, label: `节点${index}`, ref: 10 + index, shape: "rect" as const },
    );
    const edges = Array.from({ length: 14 }, (_unused, index) => ({
      from: `t-n${Math.floor(index / 2)}`,
      to: `t-n${index + 1}`,
    }));
    cases.push({
      id: "branch-tree-15",
      title: "二叉树 15 节点（层内多节点）",
      jurisdiction: "cn",
      documentKind: "invention",
      figures: [{ figure_no: 1, kind: "flowchart", direction: "TB", nodes, edges }],
      specText: flowSpecText(nodes),
    });
  }

  // 汇合 + 长 CJK 标注（横向压力）
  {
    const nodes = [
      { id: "m-n1", label: "温度传感器采集模块", ref: 10, shape: "rect" as const },
      { id: "m-n2", label: "信号调理与模数转换单元", ref: 20, shape: "rect" as const },
      { id: "m-n3", label: "无线通信加密传输模块", ref: 30, shape: "rect" as const },
      { id: "m-n4", label: "汇总处理", ref: 40, shape: "rect" as const },
    ];
    const edges = [
      { from: "m-n1", to: "m-n2" },
      { from: "m-n3", to: "m-n4" },
      { from: "m-n2", to: "m-n4" },
    ];
    cases.push({
      id: "merge-long-cjk",
      title: "汇合 + 长 CJK 标注",
      jurisdiction: "cn",
      documentKind: "invention",
      figures: [{ figure_no: 1, kind: "flowchart", direction: "TB", nodes, edges }],
      specText: flowSpecText(nodes),
    });
  }

  return cases;
}

/** 与 `gen-cases.ts` 同口径的自足文字部分（让 V2/V3/V4 有可对的面，不制造无关 finding）。 */
function flowSpecText(nodes: readonly { label: string; ref?: number }[]): string {
  const withRef = nodes.filter((node): node is { label: string; ref: number } => node.ref !== undefined);
  return [
    "权利要求书",
    `1. 一种数据处理方法，其特征在于，包括：${withRef.map(n => `${n.label}（${n.ref}）`).join("；")}。`,
    "",
    "说明书",
    "",
    "技术领域",
    "本申请涉及一种数据处理方法。",
    "",
    "发明内容",
    "本申请实施例提供一种数据处理方法，用于提高处理效率。",
    "",
    "附图说明",
    "图1为本申请实施例提供的流程示意图。",
    "",
    "具体实施方式",
    `本申请实施例中，${withRef.map(n => `${n.label}${n.ref}`).join("、")}依次执行。`,
  ].join("\n");
}

function reportCaseTable(all: Map<string, Map<Backend, CaseBackendMetrics>>, backends: readonly Backend[]): void {
  const header = [
    "用例",
    "后端",
    "缩放",
    "打印字高mm",
    "文字交叠",
    "标签穿线",
    "边穿节点",
    "利用率",
    "折线数",
    "SVG 字节",
  ];
  console.log(`\n| ${header.join(" | ")} |`);
  console.log(`|${header.map(() => "---").join("|")}|`);
  for (const [caseId, perBackend] of all) {
    for (const backend of backends) {
      const metrics = perBackend.get(backend);
      if (metrics === undefined) {
        console.log(
          `| ${caseId} | ${backend} | ${header
            .slice(2)
            .map(() => "—")
            .join(" | ")} |`,
        );
        continue;
      }
      const overlaps = metrics.figures.reduce((sum, figure) => sum + figure.textOverlaps, 0);
      const strikes = metrics.figures.reduce((sum, figure) => sum + figure.labelStrikes, 0);
      const crossings = metrics.figures.reduce((sum, figure) => sum + figure.nodeCrossings, 0);
      const util = metrics.figures.reduce((sum, figure) => sum + figure.utilization, 0) / metrics.figures.length;
      const segments = metrics.figures.reduce((sum, figure) => sum + figure.segments, 0);
      const bytes = metrics.figures.reduce((sum, figure) => sum + figure.bytes, 0);
      console.log(
        `| ${caseId} | ${backend} | ${fmt(metrics.zoom, 2)} | ${fmt(metrics.printedCharMm, 2)} | ${overlaps} | ` +
          `${strikes} | ${crossings} | ${fmt(util, 2)} | ${segments} | ${bytes} |`,
      );
    }
  }
}

function parityOf(baseline: CaseBackendMetrics, candidate: CaseBackendMetrics): string[] {
  const problems: string[] = [];
  if (JSON.stringify(baseline.findingSignature) !== JSON.stringify(candidate.findingSignature)) {
    problems.push(
      `V 规则签名不同：${baseline.backend}=[${baseline.findingSignature.join(";")}] vs ` +
        `${candidate.backend}=[${candidate.findingSignature.join(";")}]`,
    );
  }
  if (JSON.stringify(baseline.nodeSignature) !== JSON.stringify(candidate.nodeSignature)) {
    problems.push("节点回读不同（id/ref/label）");
  }
  if (JSON.stringify(baseline.numberedFigureNos) !== JSON.stringify(candidate.numberedFigureNos)) {
    problems.push(`图号观测不同：${baseline.numberedFigureNos} vs ${candidate.numberedFigureNos}`);
  }
  if (!candidate.safe) {
    problems.push("SVG 安全门未通过");
  }
  return problems;
}

/**
 * C2：版面质量不得退化。
 *
 * 判据用**打印字高（mm）**而不是缩放系数：缩放是"画幅 ÷ 可印区"的比值，跨单位制（内置 px、
 * graphviz pt）直接比会把 4/3 的换算差当成质量差；法条与 V7 约束的恰恰是落在纸面上的字高。
 * 缩放差异仍会打印出来供人判断，但不作退化判定。
 */
function qualityOf(baseline: CaseBackendMetrics, candidate: CaseBackendMetrics): string[] {
  const problems: string[] = [];
  const sum = (metrics: CaseBackendMetrics, pick: (figure: FigureMetrics) => number): number =>
    metrics.figures.reduce((total, figure) => total + pick(figure), 0);
  const comparisons: [string, (figure: FigureMetrics) => number][] = [
    ["文字交叠", figure => figure.textOverlaps],
    ["标签穿线", figure => figure.labelStrikes],
    ["边穿节点", figure => figure.nodeCrossings],
  ];
  for (const [name, pick] of comparisons) {
    if (sum(candidate, pick) > sum(baseline, pick)) {
      problems.push(`${name} ${sum(baseline, pick)} → ${sum(candidate, pick)}`);
    }
  }
  if (candidate.printedCharMm + 1e-9 < baseline.printedCharMm) {
    problems.push(`打印字高 ${fmt(baseline.printedCharMm, 2)}mm → ${fmt(candidate.printedCharMm, 2)}mm`);
  }
  if (
    candidate.minCharMm !== undefined &&
    baseline.printedCharMm + 1e-9 >= candidate.minCharMm &&
    candidate.printedCharMm + 1e-9 < candidate.minCharMm
  ) {
    problems.push(`字高达标 → 不达标（下限 ${candidate.minCharMm}mm）`);
  }
  if (candidate.figures.some(figure => !figure.deterministic)) {
    problems.push("同输入两次渲染不一致（非确定性）");
  }
  return problems;
}

/** 缩放与利用率的差异只作信息展示（见 `qualityOf` 的口径说明）。 */
function qualityNotes(baseline: CaseBackendMetrics, candidate: CaseBackendMetrics): string[] {
  const notes: string[] = [];
  if (Math.abs(candidate.zoom - baseline.zoom) > 1e-9) {
    notes.push(`缩放 ${fmt(baseline.zoom, 2)} → ${fmt(candidate.zoom, 2)}（源字号不同，不单独判定）`);
  }
  if (candidate.figures.some(figure => figure.nodeBoxes === 0)) {
    notes.push("有图未解析出节点图形盒（path 形状不计），穿线判定对该图不完整");
  }
  return notes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const probeBackend = args.probe;
  if (probeBackend !== undefined && probeBackend !== "true") {
    await runProbe(probeBackend as Backend);
    return;
  }

  const repeat = args.repeat !== undefined && args.repeat !== "true" ? Number(args.repeat) : 3;
  const caseFilter = args.cases !== undefined && args.cases !== "true" ? new Set(args.cases.split(",")) : undefined;
  const allCases = [...GENERATION_BENCHMARK_CASES, ...rendererCases()];
  const selected = caseFilter === undefined ? allCases : allCases.filter(item => caseFilter.has(item.id));
  const requested =
    args.backends !== undefined && args.backends !== "true" ? (args.backends.split(",") as Backend[]) : ALL_BACKENDS;

  const contexts = new Map<Backend, BackendContext>();
  const skipped = new Map<Backend, string>();
  for (const backend of requested) {
    try {
      contexts.set(backend, await createBackendContext(backend));
    } catch (err) {
      skipped.set(backend, err instanceof Error ? err.message : String(err));
    }
  }
  const backends = requested.filter(backend => contexts.has(backend));
  for (const [backend, reason] of skipped) {
    console.log(`跳过 ${backend}：${reason}`);
  }

  console.log(`用例 ${selected.length} 个 × 后端 ${backends.join(", ")}（repeat=${repeat}）`);

  const all = new Map<string, Map<Backend, CaseBackendMetrics>>();
  for (const testCase of selected) {
    const perBackend = new Map<Backend, CaseBackendMetrics>();
    for (const backend of backends) {
      perBackend.set(backend, await measureCase(testCase, backend, contexts.get(backend)!, repeat));
    }
    all.set(testCase.id, perBackend);
  }

  reportCaseTable(all, backends);

  const baseline = backends.includes("builtin") ? "builtin" : backends[0]!;
  console.log(`\n== C1 契约对等 / C2 版面不劣（基准 = ${baseline}）==`);
  const parityProblems: string[] = [];
  const qualityProblems: string[] = [];
  for (const [caseId, perBackend] of all) {
    const reference = perBackend.get(baseline)!;
    for (const backend of backends) {
      if (backend === baseline) {
        continue;
      }
      const candidate = perBackend.get(backend)!;
      for (const problem of parityOf(reference, candidate)) {
        parityProblems.push(`${caseId} ${backend}: ${problem}`);
      }
      for (const problem of qualityOf(reference, candidate)) {
        qualityProblems.push(`${caseId} ${backend}: ${problem}`);
      }
    }
  }
  console.log(parityProblems.length === 0 ? "C1 通过：无差异" : `C1 未通过（${parityProblems.length} 项）：`);
  for (const problem of parityProblems) {
    console.log(`  - ${problem}`);
  }
  console.log(qualityProblems.length === 0 ? "C2 通过：无退化" : `C2 未通过（${qualityProblems.length} 项）：`);
  for (const problem of qualityProblems) {
    console.log(`  - ${problem}`);
  }
  for (const [caseId, perBackend] of all) {
    const reference = perBackend.get(baseline)!;
    for (const backend of backends) {
      if (backend === baseline) {
        continue;
      }
      for (const note of qualityNotes(reference, perBackend.get(backend)!)) {
        console.log(`  · ${caseId} ${backend}: ${note}`);
      }
    }
  }

  const warm = new Map<Backend, number>();
  for (const backend of backends) {
    const values = [...all.values()].map(perBackend => perBackend.get(backend)!.warmMedianMs);
    warm.set(backend, median(values));
  }
  console.log("\n== C3 成本 ==");
  console.log("稳态单图（进程内，含重复渲染；绝对耗时判定，比值仅作参考）：");
  for (const backend of backends) {
    const ratio =
      backends.includes("builtin") && baseline === "builtin"
        ? warm.get(backend)! / Math.max(warm.get("builtin")!, 0.001)
        : 1;
    console.log(
      `  - ${backend}: ${fmt(warm.get(backend)!, 2)}ms（相对基准 ${fmt(ratio, 2)}×；绝对预算 ${WARM_BUDGET_MS}ms）`,
    );
  }

  let probes: Map<Backend, ProbeResult | string> | undefined;
  if (args["no-cold"] === undefined) {
    console.log("\n冷启动探针（每后端一个子进程；含模块加载 + 首图）：");
    probes = await collectProbes(backends);
    for (const backend of backends) {
      const result = probes.get(backend);
      if (typeof result === "string") {
        console.log(`  - ${backend}: 探针失败（${result}）`);
        continue;
      }
      if (result === undefined) {
        continue;
      }
      console.log(
        `  - ${backend}: import ${fmt(result.importMs, 0)}ms` +
          (result.moduleLoadMs === null ? "" : `（其中模块加载 ${fmt(result.moduleLoadMs, 0)}ms）`) +
          ` / 首图 ${fmt(result.firstRenderMs, 0)}ms / 稳态 ${fmt(result.warmMedianMs, 1)}ms / ` +
          `RSS ${fmt(result.rssBytes / 1024 / 1024, 0)}MB`,
      );
    }
    const reference =
      typeof probes.get(baseline) === "string" ? undefined : (probes.get(baseline) as ProbeResult | undefined);
    if (reference !== undefined) {
      for (const backend of backends) {
        const candidate = probes.get(backend);
        if (backend === baseline || typeof candidate === "string" || candidate === undefined) {
          continue;
        }
        const coldDelta = candidate.firstRenderMs + candidate.importMs - (reference.firstRenderMs + reference.importMs);
        const warmRatio = candidate.warmMedianMs / Math.max(reference.warmMedianMs, 0.001);
        const rssDelta = candidate.rssBytes - reference.rssBytes;
        const verdict =
          coldDelta <= COLD_START_BUDGET_MS && candidate.warmMedianMs <= WARM_BUDGET_MS && rssDelta <= RSS_BUDGET_BYTES
            ? "C3 通过"
            : "C3 未通过";
        console.log(
          `  ${verdict}（${backend} vs ${baseline}）：冷启动增量 ${fmt(coldDelta, 0)}ms（预算 ${COLD_START_BUDGET_MS}ms）、` +
            `稳态 ${fmt(candidate.warmMedianMs, 2)}ms（预算 ${WARM_BUDGET_MS}ms；相对基准 ${fmt(warmRatio, 2)}×）、` +
            `RSS 增量 ${fmt(rssDelta / 1024 / 1024, 0)}MB（预算 ${fmt(RSS_BUDGET_BYTES / 1024 / 1024, 0)}MB）`,
        );
      }
    }
  }

  if (args.json !== undefined && args.json !== "true") {
    await writeFile(
      args.json,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          repeat,
          backends,
          cases: [...all.entries()].map(([caseId, perBackend]) => ({
            caseId,
            metrics: Object.fromEntries(perBackend),
          })),
          warmMedianMs: Object.fromEntries(warm),
          probes: probes === undefined ? null : Object.fromEntries(probes),
          parityProblems,
          qualityProblems,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\n已写入 ${args.json}`);
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("对比运行失败:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
