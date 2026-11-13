/**
 * src/patent/figuregen — 多面板附图拼版渲染器（FIG.1A / FIG.1B 这类部分视图）。
 *
 * 一幅附图里同时给出若干**面板**（子图）时，各面板共享**同一套附图标记系列**：
 * 同一部件在 FIG.1A 与 FIG.1B 里是同一个号（细则第 21 条的双向核验对象是号，不是格）。
 * 本模块把 `spec.panels` 拼成**一幅**图（面板网格），而不是拼成若干幅图——
 * FIG.1A/FIG.1B 是同一幅附图的两个部分视图，合在一张纸上。
 *
 * **三条设计纪律**（与既有渲染器同源，改动前先想清楚）：
 *
 * 1. **标号可见化必须先于布局**。节点有 `ref` 而 label 未带可见标号时，先用
 *    `withVisibleNumeral` 归一 label，再把**归一后的 label** 交给 `layoutFigure`：
 *    盒宽预算与图面文字必须同源，否则补画的 `(20)` 会撑出盒外（既有渲染器踩过这个坑，
 *    复核侧报「文字被框线贯穿」）。
 * 2. **各面板同一缩放系数**。部分视图里同一部件在两格中必须是同一尺寸，否则两格互相矛盾
 *    （FIG.1A 的电机比 FIG.1B 的电机大 ⇒ 读者无法判断是不是同一部件）。故缩放系数取
 *    **全格最小值**（`min` over panels），而不是逐格各算各的。
 * 3. **只缩不放，且线宽不随缩放走**。缩放系数恒 ≤ 1：放大会让图面字高与纸面口径脱节
 *    （V7 字高判据按法域档案核验，放大后的字高不是纸面事实）。线宽固定 1.5px
 *    （审查指南一部一章 4.3/4.6 的黑白线宽下限），不随缩放系数变小——否则缩小后线宽
 *    跌破下限。缩放作用于**坐标与字号**，不作用于线宽。
 *
 * **格内可用区从哪来**：面板格的可用区按**纸面可印区**（`page-contract.ts` 的
 * `PRINTABLE_WIDTH_MM`/`PRINTABLE_HEIGHT_MM`）推：整幅拼版图最终要落在一页附图页上，
 * 可用区是外部事实，不是内容事实。若可用区由内容自身推出（可用区 = 最大面板尺寸），
 * 则缩放系数恒为 1、缩放逻辑形同虚设；按纸面可用区推，格子才是"放得下"的真实约束。
 *
 * **形状画法与既有渲染器同源**：`renderShape` 已提到 `render-utils.ts` 供本模块与内置
 * 渲染器共用（单一事实源：形状口径漂一处，三处画出来的同一个形状就会不一样）。
 * 文本排布（行距、基线微调、
 * 白色描边）在 `render-svg.ts` 里有一份实现，此处按同一口径再写一份——`render-svg.ts`
 * 未导出这些函数，而本轮不得改动既有文件。两处若要改口径（如换行距常量）必须**同改**；
 * 待允许改动既有文件时，应把形状绘制提到 `render-utils.ts` 一处，两边共用。
 *
 * **黑白不变式**：本模块只产出 `#000000` 描边/文字与 `none`/`#FFFFFF` 填充，无灰度、
 * 无彩色、无渐变、无阴影、无外部引用（不产出 `<image>`），与
 * `render-svg.ts` 的构造期保证一致（审查指南一部一章 4.3/4.6）。
 *
 * 输出确定性：无时钟/随机/locale 依赖（同一 spec 永远产出逐字节相同的 body）。
 */

import { defaultDirection, isSymbolShape, layoutFigure, type FigureLayout } from "./layout.js";
import { withVisibleNumeral } from "./numeral-assign.js";
import { CSS_PX_PER_INCH, MM_PER_INCH, PRINTABLE_HEIGHT_MM, PRINTABLE_WIDTH_MM } from "./page-contract.js";
import { escapeXml, fmt, renderShape } from "./render-utils.js";
import type { FigureNode, FigurePanel, FigureSpec } from "./types.js";

/** 格与格之间的留白（px）。 */
const CELL_GAP = 24;
/** 格框内的留白（px）：面板内容不贴框线。 */
const CELL_PAD = 12;
/** 面板标题与格内内容之间的距离（px）。 */
const TITLE_GAP = 8;
/** 行距增量（px）：与 `layout.ts` 的 `LINE_HEIGHT_GAP` 同源（行高 = 字号 + 该增量）。 */
const LINE_HEIGHT_GAP = 7;
/** 文本基线微调（px）：与 `render-svg.ts` 同源（把视觉中心对到盒中心）。 */
const BASELINE_ADJUST = 3;
/** 图线线宽（px）：黑白附图的线宽下限即 1.5，且**不随缩放系数变化**。 */
const STROKE_WIDTH = 1.5;
/** 边标签白色描边宽度（px）：与 `render-svg.ts` 同源（`paint-order="stroke"` 的字外圈）。 */
const LABEL_HALO_WIDTH = 4;

/** 多面板拼版图的版面结果。 */
export type PanelSheetLayout = {
  /** SVG 片段（不含 `<svg>` 根、不含 defs、不含图号）。 */
  body: string;
  /** 整幅拼版图的画幅（px）。 */
  width: number;
  height: number;
  /** 箭头 marker 定义（调用方放进 `<defs>`）。 */
  defs?: string;
  /** 实际网格形状（列数/行数），供报告出声。 */
  grid?: { columns: number; rows: number };
};

/** 网格形状：列数 = ⌈√n⌉，行数 = ⌈n/列数⌉（2 格→1×2，3 格→2 列（下行 1），4 格→2×2）。 */
function gridShape(panelCount: number): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(panelCount));
  const rows = Math.ceil(panelCount / columns);
  return { columns, rows };
}

/** 毫米 → CSS px（纸面常量与图面坐标的唯一换算口径，见 `page-contract.ts`）。 */
function mmToPx(mm: number): number {
  return (mm / MM_PER_INCH) * CSS_PX_PER_INCH;
}

/** 节点 id → 合法 XML id 片段（与 `render-svg.ts` 同口径）。 */
function xmlId(nodeId: string): string {
  return nodeId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
}

/**
 * 节点 label 归一：有 `ref` 而 label 未带可见标号时补 `(ref)`。
 *
 * 归一**必须先于布局**（见模块头纪律 1）：盒宽按归一后的文字算，图面也画归一后的文字，
 * 两处同源，文字不会溢出盒外。
 */
function normalizeNode(node: FigureNode): FigureNode {
  if (node.ref === undefined) return node;
  const label = withVisibleNumeral(node.label, node.ref);
  return label === node.label ? node : { ...node, label };
}

/** 一个面板的预备结果：归一后的节点与它在自身坐标系下的布局。 */
type PreparedPanel = {
  readonly panel: FigurePanel;
  readonly nodes: readonly FigureNode[];
  readonly layout: FigureLayout;
};

/**
 * 节点文字（与 `render-svg.ts` 的 `renderNodeText` 同口径）。
 *
 * `fontSizePx` 已是**缩放后**的字号；行距与基线微调按同一系数缩放，字面高度与格内布局一致。
 */
function renderNodeText(
  label: string,
  p: { x: number; y: number; width: number; height: number },
  fontSizePx: number,
  scale: number,
): string {
  const lines = label.split("\\n");
  const lineHeight = fontSizePx + LINE_HEIGHT_GAP * scale;
  const startY = p.y + p.height / 2 - ((lines.length - 1) * lineHeight) / 2 + fontSizePx / 2 - BASELINE_ADJUST * scale;
  return lines
    .map(
      (line, i) =>
        `<text x="${fmt(p.x + p.width / 2)}" y="${fmt(startY + i * lineHeight)}" font-size="${fmt(fontSizePx)}" ` +
        `text-anchor="middle" fill="#000000">${escapeXml(line)}</text>`,
    )
    .join("");
}

/** 箭头 marker 定义（与 `render-svg.ts` 同口径；层级图的连线表示包含关系，不画箭头）。 */
function arrowDefs(): string {
  return (
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" ` +
    `orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 Z" fill="#000000"/></marker></defs>`
  );
}

/**
 * 渲染多面板附图为**一幅**图的 SVG 片段。
 *
 * `spec.panels` 缺省或为空 ⇒ 返回空 body（调用方退回单幅渲染，不产出空图）。
 * 面板数 = 格数；网格形状见 {@link gridShape}。
 *
 * 缩放：各面板先在自己的坐标系里布局（`layoutFigure`），再**等比**缩放进格内可用区；
 * 系数 = min(可用宽/布局宽, 可用高/布局高)，且**不得超过 1**；全格取同一系数
 * （见模块头纪律 2）。字号按同一系数缩放（见纪律 3）。
 *
 * @param spec - 附图结构化描述（`panels` 承载图面内容，顶层 nodes/edges 忽略）。
 * @param options - 主字号与边标签字号（px）；两者都是**未缩放**的基准字号。
 * @returns 拼版版面（片段、画幅、defs、网格形状）。
 */
export function renderPanelSheet(
  spec: FigureSpec,
  options: { fontSizePx: number; edgeFontSizePx: number },
): PanelSheetLayout {
  const panels = spec.panels ?? [];
  if (panels.length === 0) {
    // 没有面板 ⇒ 没有图面内容：返回空片段，由调用方退回单幅渲染（不产出"空图"）。
    return { body: "", width: 0, height: 0 };
  }

  const { columns, rows } = gridShape(panels.length);

  // 面板预备：标号可见化归一 → 单面板布局（面板内不含图号带：图号属于整幅图）。
  const prepared: PreparedPanel[] = panels.map(panel => {
    const nodes = panel.nodes.map(normalizeNode);
    const panelSpec: FigureSpec = {
      figure_no: spec.figure_no,
      kind: spec.kind,
      direction: panel.direction ?? spec.direction ?? defaultDirection(spec.kind),
      nodes: nodes.slice(),
      edges: panel.edges,
    };
    const layout = layoutFigure(panelSpec, { caption: false, fontSizePx: options.fontSizePx });
    return { panel, nodes, layout };
  });

  // 格内可用区：按纸面可印区推（外部事实；内容推出的可用区会让缩放系数恒为 1）。
  const printableW = mmToPx(PRINTABLE_WIDTH_MM);
  const printableH = mmToPx(PRINTABLE_HEIGHT_MM);
  const hasTitle = prepared.some(p => typeof p.panel.title === "string" && p.panel.title.length > 0);
  // 标题带按未缩放字号预估（缩放后只会更小 ⇒ 预估是上界，可用区不会算窄）。
  const titleBandUpper = hasTitle ? options.fontSizePx + TITLE_GAP : 0;
  const availCellW = Math.max(1, (printableW - (columns - 1) * CELL_GAP) / columns);
  const availCellH = Math.max(1, (printableH - (rows - 1) * CELL_GAP) / rows - titleBandUpper);

  // 缩放系数：逐格算出各自的系数后取全格最小值（各面板同一系数，见模块头纪律 2）。
  let scale = 1;
  for (const item of prepared) {
    const own = Math.min(availCellW / item.layout.width, availCellH / item.layout.height, 1);
    scale = Math.min(scale, own);
  }

  const fontSize = options.fontSizePx * scale;
  const edgeFont = options.edgeFontSizePx * scale;
  const titleBand = hasTitle ? fontSize + TITLE_GAP : 0;

  // 格子尺寸：取缩放后各面板的包络（网格要规则 ⇒ 所有格同尺寸）。
  const contentW = Math.max(...prepared.map(p => p.layout.width * scale));
  const contentH = Math.max(...prepared.map(p => p.layout.height * scale));
  const cellW = contentW + CELL_PAD * 2;
  const cellH = contentH + CELL_PAD * 2 + titleBand;
  const sheetW = columns * cellW + (columns - 1) * CELL_GAP;
  const sheetH = rows * cellH + (rows - 1) * CELL_GAP;

  // 层级图的边表示包含关系（整体—组成部分），按惯用观感不画箭头；其余图型画箭头。
  const edgeMarker = spec.kind === "hierarchy" ? "" : ` marker-end="url(#arrow)"`;

  // 节点 id 在整幅图内必须唯一（同一部件可出现在多个面板）⇒ 首次出现用原 id，
  // 再次出现追加面板序号；原始 id 始终另存 `data-node-id` 供机器回读。
  const usedIds = new Set<string>();
  const parts: string[] = [];

  prepared.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = column * (cellW + CELL_GAP);
    const cellY = row * (cellH + CELL_GAP);
    const offsetX = cellX + CELL_PAD + (contentW - item.layout.width * scale) / 2;
    const offsetY = cellY + CELL_PAD + (contentH - item.layout.height * scale) / 2;

    const inner: string[] = [];

    // 格框（细边框标示分格；空格也画框，见"每格一框"）。
    inner.push(
      `<rect x="${fmt(cellX)}" y="${fmt(cellY)}" width="${fmt(cellW)}" height="${fmt(cellH)}" ` +
        `fill="none" stroke="#000000" stroke-width="${fmt(STROKE_WIDTH)}"/>`,
    );

    // 边：折线 + 可选标签（标签带白色描边，压在折线上也读得出）。
    for (const routed of item.layout.edges) {
      const points = routed.points.map(pt => `${fmt(offsetX + pt.x * scale)},${fmt(offsetY + pt.y * scale)}`).join(" ");
      inner.push(
        `<polyline fill="none" stroke="#000000" stroke-width="${fmt(STROKE_WIDTH)}"${edgeMarker} ` +
          (routed.edge.dashed ? `stroke-dasharray="6 4" ` : "") +
          `points="${points}"/>`,
      );
      if (routed.edge.label && routed.labelAt) {
        inner.push(
          `<text x="${fmt(offsetX + routed.labelAt.x * scale)}" y="${fmt(offsetY + routed.labelAt.y * scale)}" ` +
            `font-size="${fmt(edgeFont)}" text-anchor="middle" fill="#000000" stroke="#FFFFFF" ` +
            `stroke-width="${fmt(LABEL_HALO_WIDTH)}" paint-order="stroke">${escapeXml(routed.edge.label)}</text>`,
        );
      }
    }

    // 节点：形状 + 文字；带 ref 时写 data-ref（核验器回读附图标记的机器契约）。
    for (const positioned of item.layout.nodes) {
      const node = positioned.node;
      const box = {
        x: offsetX + positioned.x * scale,
        y: offsetY + positioned.y * scale,
        width: positioned.width * scale,
        height: positioned.height * scale,
      };
      const shape = renderShape(node.shape ?? "rect", box);
      const text = isSymbolShape(node.shape) ? "" : renderNodeText(node.label, box, fontSize, scale);
      let groupId = `n-${xmlId(node.id)}`;
      if (usedIds.has(groupId)) {
        groupId = `${groupId}-p${String(index)}`;
      }
      usedIds.add(groupId);
      const refAttr = node.ref === undefined ? "" : ` data-ref="${String(node.ref)}"`;
      inner.push(`<g id="${groupId}"${refAttr} data-node-id="${escapeXml(node.id)}">${shape}${text}</g>`);
    }

    // 面板标题（格内内容下方；缺省不画）。
    const title = item.panel.title;
    if (typeof title === "string" && title.length > 0) {
      inner.push(
        `<text x="${fmt(cellX + cellW / 2)}" y="${fmt(cellY + CELL_PAD + contentH + fontSize)}" ` +
          `font-size="${fmt(fontSize)}" text-anchor="middle" fill="#000000">${escapeXml(title)}</text>`,
      );
    }

    parts.push(`<g class="panel" data-panel="${String(index)}">${inner.join("")}</g>`);
  });

  return {
    body: parts.join(""),
    width: sheetW,
    height: sheetH,
    defs: arrowDefs(),
    grid: { columns, rows },
  };
}
