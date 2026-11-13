/**
 * src/patent/figuregen — 时序图渲染器（参与者生命线 + 消息；纯 SVG 片段）。
 *
 * **语义**：时序图**复用 FigureSpec 的 nodes/edges 结构**（不另开数据结构）——
 * `nodes` = 参与者（数组顺序 = 从左到右的列），`edges` = 消息（数组顺序 = 时序，
 * 从上到下）。故本模块与分层布局器（`layout.ts`）平行：自己算列位与行位、自己出
 * SVG 片段，由 `render-svg.ts` 统一接入（统一加 `<svg>` 根与图号）。
 *
 * **画法**：
 * - 参与者：顶部一个圆角矩形（`shape` 忽略——参与者框统一圆角矩形），框下一条竖直
 *   虚线生命线贯穿消息区，直到最后一条消息之下再留一段余量；
 * - 消息：水平实线 + 实心箭头（marker 写在 defs 里，id `seq-arrow`），消息文本画在线
 *   **上方**居中；`edge.dashed === true` 画虚线（返回消息/应答）；
 * - 自消息（`from === to`）：在生命线**右侧**画一个小的折返回环（从生命线出发、右侧
 *   折返、箭头回到生命线），文本在回环右侧；
 * - 参与者之间**不画**连线：相对顺序由调用方给定的节点顺序决定。
 *
 * **图面合规**（审查指南 2023 一部一章 4.3/4.6）：
 * - 黑白不变式：描边与文字只用 `#000000`，填充只用 `#FFFFFF`/`none`；箭头实心标记
 *   同为 `#000000`（与 `render-svg.ts` 的 marker 同口径）；
 * - 线宽 1.5（不低于 1.5 的下限）；
 * - 字号一律取入参（`fontSizePx` / `edgeFontSizePx`），本模块**不写死像素值**——
 *   V7 的纸面字高按法域档案核验，字号写死会让图面与核验口径脱钩；
 * - 一切文本过 `escapeXml`，一切坐标过 `fmt`（不留浮点尾巴）。
 *
 * **附图标记**（细则第 21 条）：节点带 `ref` 时用 `withVisibleNumeral` 把 `(ref)`
 * **补进 label 再取文本**——图面只画一次（与渲染期补画同源，不会出现
 * 「处理模块(20)(20)」），盒宽也按补画后的文本估（布局与渲染同源）。
 *
 * **回读兼容**：参与者分组沿用内置渲染器的 `id="n-<nodeId>"` 契约并把 `ref` 写在
 * `data-ref` 上，故 `readback.ts` 能把参与者读回成节点（V2/V3 的图↔文双向核对
 * 对时序图同样成立）。
 *
 * **与复核侧同源**：文字占位框（升降比）与盒宽估算复用 `glyph-box.ts` 的口径——
 * 绘图侧按自己的口径摆字、复核侧按另一口径判「文字是否贴线」，两侧不一致就会把
 * 正确的图报成缺陷（RC2 净距）。底部预留图号标注带（`options.caption`，缺省按
 * "会画图号"处理），使生命线止于图号文字之上。
 *
 * 纯函数：无时钟、无随机、无字体测量（字宽按 `metrics.ts` 的字符类别累计）。
 */

import { GLYPH_ASCENT_RATIO, GLYPH_DESCENT_RATIO, textWidthMm } from "./glyph-box.js";
import { measureTextWidth } from "./metrics.js";
import { withVisibleNumeral } from "./numeral-assign.js";
import { escapeXml, fmt } from "./render-utils.js";
import type { FigureNode, FigureSpec } from "./types.js";

/** 时序图布局产物：SVG 片段（不含 `<svg>` 根、不含 defs、不含图号）。 */
export type SequenceDiagramLayout = {
  /** SVG 片段（不含 <svg> 根、不含 defs、不含图号）。 */
  body: string;
  /** 画布宽高（px）。 */
  width: number;
  height: number;
  /** 可选 defs（如箭头 marker）；不需要时省略该字段。 */
  defs?: string;
};

/** 线宽（px）：与内置渲染器同口径，且不低于 1.5 的下限。 */
const STROKE_WIDTH = 1.5;
/** 虚线段长（px）：生命线与返回消息共用同一形态。 */
const DASH_PATTERN = "6 4";
/** 箭头 marker 的 id（写在 defs 里）。 */
const ARROW_MARKER_ID = "seq-arrow";
/** 画布四周留白（px）。 */
const CANVAS_MARGIN = 20;
/** 相邻参与者之间的水平间距（px）。 */
const PARTICIPANT_GAP = 48;
/** 参与者框内文字的左右留白（px）：与 `layout.ts` 的 PAD_X 同口径（≥1.5mm 净距）。 */
const BOX_PAD_X = 16;
/** 参与者框内文字的上下留白（px）：与 `layout.ts` 的 PAD_Y 同口径（≥1.5mm 净距）。 */
const BOX_PAD_Y = 12;
/** 行距增量（px）：行高 = 字号 + 该增量（与 `layout.ts` 的 LINE_HEIGHT_GAP 同口径）。 */
const LINE_HEIGHT_GAP = 6;
/** 参与者框最小宽度（px）。 */
const BOX_MIN_WIDTH = 80;
/** 图号标注带高度（px）：与 `layout.ts` 的 CAPTION_H 同源——图号由调用方画在图形正下方。 */
const CAPTION_BAND_H = 40;
/** 参与者框圆角半径（px）。 */
const BOX_RADIUS = 4;
/** 自消息回环宽度（px）：自生命线向右伸出的水平距离。 */
const SELF_LOOP_WIDTH = 28;
/** 自消息回环高度（px）：折返的垂直距离。 */
const SELF_LOOP_HEIGHT = 24;
/** 自消息文字与回环的间距（px）。 */
const SELF_LABEL_GAP = 10;
/** 消息文字基线与消息线之间的最小间距（px）。 */
const LABEL_MIN_GAP = 8;

/** 参与者（列）的度量。 */
type Participant = {
  node: FigureNode;
  /** 图面文本（已补进可见标号）。 */
  label: string;
  /** 框左边 x。 */
  left: number;
  /** 框宽。 */
  width: number;
  /** 框高。 */
  height: number;
  /** 框顶 y。 */
  top: number;
  /** 框底 y（生命线起点）。 */
  bottom: number;
  /** 框中心 x（生命线 x）。 */
  x: number;
};

/** 节点 id → 合法 XML id 片段（与 `render-svg.ts` 同口径）。 */
function xmlId(nodeId: string): string {
  return nodeId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
}

/** 行高（px）：与字号同源。 */
function lineHeightOf(fontSizePx: number): number {
  return fontSizePx + LINE_HEIGHT_GAP;
}

/**
 * 多行文本以纵向中心对齐时的**最后一行**基线。
 *
 * 用 `glyph-box.ts` 的升降比（与复核侧的文字占位框**同一模型**）：绘图侧按自己的口径
 * 摆字、复核侧按另一口径判「文字是否贴线」，两侧不一致就会把正确的图报成缺陷。
 */
function centeredLastBaseline(centerY: number, lineCount: number, fontSizePx: number): number {
  const lineHeight = lineHeightOf(fontSizePx);
  const halfGap = (GLYPH_ASCENT_RATIO - GLYPH_DESCENT_RATIO) / 2;
  return centerY + ((lineCount - 1) * lineHeight) / 2 + halfGap * fontSizePx;
}

/**
 * 画一段文本（可多行）。
 *
 * `lastBaseline` 是**最后一行**的基线（多行时其余行自下往上排）——调用方按"文字块
 * 底部贴着某条线"或"文字块居中于某处"给值，文字块不会溢出预定区域。
 */
function renderText(
  text: string,
  x: number,
  lastBaseline: number,
  fontSizePx: number,
  options: { anchor?: "middle" | "start"; halo?: boolean } = {},
): string {
  const anchor = options.anchor ?? "middle";
  const lines = text.split("\n");
  const lineHeight = lineHeightOf(fontSizePx);
  // 白色描边挖空（halo）：与内置渲染器的边标签同口径——文字压线时在字外围形成
  // 一圈白边把线视觉断开（复核侧对带 halo 的文字不判"文字被线贯穿"）。
  const halo = options.halo === true ? ` stroke="#FFFFFF" stroke-width="4" paint-order="stroke"` : "";
  const parts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const baseline = lastBaseline - (lines.length - 1 - index) * lineHeight;
    const line = lines[index];
    parts.push(
      `<text x="${fmt(x)}" y="${fmt(baseline)}" font-size="${fontSizePx}" text-anchor="${anchor}" ` +
        `fill="#000000"${halo}>${escapeXml(line)}</text>`,
    );
  }
  return parts.join("");
}

/**
 * 渲染一幅时序图。
 *
 * @param spec - 图面描述：`nodes` = 参与者（顺序即列序），`edges` = 消息（顺序即时序）。
 * @param options - 字号（px）：主字号与消息文字字号分别给定，本模块不自带缺省值；
 *   `caption` 缺省按"会画图号"处理（底部预留标注带），传 false 表示本幅不画图号。
 * @returns SVG 片段 + 画布尺寸 + defs（箭头 marker）。
 */
export function renderSequenceDiagram(
  spec: FigureSpec,
  options: { fontSizePx: number; edgeFontSizePx: number; caption?: boolean },
): SequenceDiagramLayout {
  const fontSizePx = options.fontSizePx;
  const edgeFontSizePx = options.edgeFontSizePx;

  // ① 参与者：先补可见标号再量盒宽（布局与渲染同源 ⇒ 文字不会溢出框）。
  const boxes = spec.nodes.map(node => {
    const label = node.ref === undefined ? node.label : withVisibleNumeral(node.label, node.ref);
    const lines = label.split("\n");
    const textWidth = lines.reduce((max, line) => {
      // 两个口径取大者：`measureTextWidth`（布局口径，CJK 1em/其余 0.5em）与
      // `glyph-box` 的文字占位框口径（复核侧量字用）。两者对西文有 0.5/0.6 的差异，
      // 只按前者量宽 ⇒ 长西文名会顶到框线（复核报"文字贴线"）。
      const layoutWidth = measureTextWidth(line, fontSizePx);
      // textWidthMm 的比例与单位无关（比例 × 字号），这里传 px 当作用户单位长度。
      const glyphWidth = textWidthMm(line, fontSizePx);
      return Math.max(max, layoutWidth, glyphWidth);
    }, 0);
    const width = Math.max(BOX_MIN_WIDTH, Math.round(textWidth) + 2 * BOX_PAD_X);
    const height = lines.length * lineHeightOf(fontSizePx) + 2 * BOX_PAD_Y;
    return { node, label, width, height };
  });

  // ② 列位：从左到右依次排布，相邻参与者之间留固定水平间距。
  const participants: Participant[] = [];
  let cursor = CANVAS_MARGIN;
  for (const box of boxes) {
    const left = cursor;
    cursor += box.width + PARTICIPANT_GAP;
    participants.push({
      node: box.node,
      label: box.label,
      left,
      width: box.width,
      height: box.height,
      top: CANVAS_MARGIN,
      bottom: CANVAS_MARGIN + box.height,
      x: left + box.width / 2,
    });
  }
  const contentRight = participants.length > 0 ? cursor - PARTICIPANT_GAP : CANVAS_MARGIN;
  const width = contentRight + CANVAS_MARGIN;

  // ③ 行位：消息在消息区均分（等步长）；生命线延伸到最后一条消息之下再留一段余量。
  const areaTop = participants.reduce((max, p) => Math.max(max, p.bottom), CANVAS_MARGIN);
  const messageTopGap = Math.round(fontSizePx * 3);
  const messageStep = Math.round(fontSizePx * 3.4);
  const messageTailGap = Math.round(fontSizePx * 2.6);
  const firstMessageY = areaTop + messageTopGap;
  const messageCount = spec.edges.length;
  const lifelineBottom =
    messageCount > 0 ? firstMessageY + (messageCount - 1) * messageStep + messageTailGap : areaTop + messageTopGap;
  // 底部留出图号标注带（与 `layout.ts` 的 CAPTION_H 同源）：图号由调用方画在图形正下方，
  // 图形内容必须止于标注带之上，否则生命线会穿过图号文字。
  const bottomBand = options.caption === false ? CANVAS_MARGIN : CAPTION_BAND_H;
  const height = lifelineBottom + bottomBand;

  // ④ 参与者框（顶部一行，文字居中；ref 写在 data-ref 上供核验器回读）。
  const boxParts = participants.map(p => {
    const refAttr = p.node.ref === undefined ? "" : ` data-ref="${p.node.ref}"`;
    const rect =
      `<rect x="${fmt(p.left)}" y="${fmt(p.top)}" width="${fmt(p.width)}" height="${fmt(p.height)}" ` +
      `rx="${BOX_RADIUS}" fill="#FFFFFF" stroke="#000000" stroke-width="${STROKE_WIDTH}"/>`;
    const text = renderText(
      p.label,
      p.x,
      centeredLastBaseline(p.top + p.height / 2, p.label.split("\n").length, fontSizePx),
      fontSizePx,
      { anchor: "middle" },
    );
    return `<g id="n-${xmlId(p.node.id)}"${refAttr}>${rect}${text}</g>`;
  });

  // ⑤ 生命线：自框底竖直向下贯穿消息区（虚线）。
  const lifelineParts = participants.map(
    p =>
      `<line id="seq-lifeline-${xmlId(p.node.id)}" x1="${fmt(p.x)}" y1="${fmt(p.bottom)}" ` +
      `x2="${fmt(p.x)}" y2="${fmt(lifelineBottom)}" fill="none" stroke="#000000" ` +
      `stroke-width="${STROKE_WIDTH}" stroke-dasharray="${DASH_PATTERN}"/>`,
  );

  // ⑥ 消息：自上而下按边序均分；实线 + 实心箭头，返回消息画虚线。
  const indexById = new Map<string, number>();
  participants.forEach((p, index) => {
    if (!indexById.has(p.node.id)) indexById.set(p.node.id, index);
  });
  const messageParts: string[] = [];
  spec.edges.forEach((edge, index) => {
    const fromIndex = indexById.get(edge.from);
    const toIndex = indexById.get(edge.to);
    if (fromIndex === undefined || toIndex === undefined) return; // 参与者不存在：跳过，不猜
    const from = participants[fromIndex];
    const to = participants[toIndex];
    if (from === undefined || to === undefined) return;
    const y = firstMessageY + index * messageStep;
    const dash = edge.dashed === true ? ` stroke-dasharray="${DASH_PATTERN}"` : "";

    if (fromIndex === toIndex) {
      // 自消息：生命线右侧的小回环（水平出发、右侧折返、箭头回到生命线）。
      const loopX = from.x + SELF_LOOP_WIDTH;
      const points = [
        `${fmt(from.x)},${fmt(y)}`,
        `${fmt(loopX)},${fmt(y)}`,
        `${fmt(loopX)},${fmt(y + SELF_LOOP_HEIGHT)}`,
        `${fmt(from.x)},${fmt(y + SELF_LOOP_HEIGHT)}`,
      ].join(" ");
      const loop =
        `<polyline id="seq-msg-${index}" fill="none" stroke="#000000" stroke-width="${STROKE_WIDTH}"` +
        `${dash} marker-end="url(#${ARROW_MARKER_ID})" points="${points}"/>`;
      const label =
        edge.label === undefined || edge.label === ""
          ? ""
          : renderText(
              edge.label,
              loopX + SELF_LABEL_GAP,
              centeredLastBaseline(y + SELF_LOOP_HEIGHT / 2, edge.label.split("\n").length, edgeFontSizePx),
              edgeFontSizePx,
              { anchor: "start", halo: true },
            );
      messageParts.push(loop + label);
      return;
    }

    const line =
      `<line id="seq-msg-${index}" x1="${fmt(from.x)}" y1="${fmt(y)}" x2="${fmt(to.x)}" y2="${fmt(y)}" ` +
      `fill="none" stroke="#000000" stroke-width="${STROKE_WIDTH}"${dash} ` +
      `marker-end="url(#${ARROW_MARKER_ID})"/>`;
    const labelGap = Math.max(LABEL_MIN_GAP, Math.round(edgeFontSizePx * 0.9));
    const label =
      edge.label === undefined || edge.label === ""
        ? ""
        : renderText(edge.label, (from.x + to.x) / 2, y - labelGap, edgeFontSizePx, {
            anchor: "middle",
            halo: true,
          });
    messageParts.push(line + label);
  });

  const defs =
    `<defs><marker id="${ARROW_MARKER_ID}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
    `markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 Z" fill="#000000"/></marker></defs>`;

  return {
    body: [...boxParts, ...lifelineParts, ...messageParts].join(""),
    width,
    height,
    defs,
  };
}
