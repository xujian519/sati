/**
 * src/patent/figuregen — 专利附图 SVG 渲染器（构造期合规）。
 *
 * 审查指南 2023 一部一章 4.3/4.6 的黑白合规是构造期不变式：仅 #000000/#FFFFFF、
 * 无渐变、无彩色函数；文字黑色背景白净。附图标记写入节点分组的 data-ref 属性
 * （供核验器/代理师工具回读），文本层同时渲染"组件名(N)"惯用形。图号按法域档案
 * 写成"图N"（CN）/ "Fig. N"（PCT）/ "FIG. N"（US），**是否需要图号由图幅数与法域
 * 决定**（单幅在 PCT/US 不得出现 "Fig."——PCT 指南 IP 5.141、37 CFR 1.84(u)(1)），
 * 需要时居中标注于图形正下方（指南一部一章 4.3"标注在相应附图的正下方"）。
 * 状态图的初态/终态用符号形状（实心圆/双圈，不渲染文字）；层级图的连线表示包含关系，
 * 不画箭头。输出确定性：无时钟/随机/ locale 依赖。
 */

import { figureCaption, profileForJurisdiction } from "./office-profile.js";
import { isSymbolShape, layoutFigure, type FigureLayout } from "./layout.js";
import { FIGURE_FONT_SIZE } from "./metrics.js";
import { FIGURE_NO_ATTRIBUTE } from "./readback.js";
import type { FigureNode, FigureNodeShape, FigureSpec, Jurisdiction } from "./types.js";

const EDGE_FONT_SIZE = 12;

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

/** 节点 id → 合法 XML id 片段。 */
function xmlId(nodeId: string): string {
  return nodeId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
}

/** 形状绘制：符号形状（circle/doublecircle）无文字，label 由 renderNodeText 跳过。 */
function renderShape(shape: FigureNodeShape, p: { x: number; y: number; width: number; height: number }): string {
  const { x, y, width: w, height: h } = p;
  const stroke = 'fill="#FFFFFF" stroke="#000000" stroke-width="1.5"';
  switch (shape) {
    case "circle": {
      return `<circle cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" r="${fmt(Math.min(w, h) / 2)}" fill="#000000"/>`;
    }
    case "doublecircle": {
      const outer = Math.min(w, h) / 2;
      const cx = fmt(x + w / 2);
      const cy = fmt(y + h / 2);
      return (
        `<circle cx="${cx}" cy="${cy}" r="${fmt(outer)}" ${stroke}/>` +
        `<circle cx="${cx}" cy="${cy}" r="${fmt(outer * 0.62)}" ${stroke}/>`
      );
    }
    case "round": {
      const radius = Math.min(h / 2, 18);
      return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(radius)}" ${stroke}/>`;
    }
    case "ellipse":
      return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}" ${stroke}/>`;
    case "diamond": {
      const points = [
        `${fmt(x + w / 2)},${fmt(y)}`,
        `${fmt(x + w)},${fmt(y + h / 2)}`,
        `${fmt(x + w / 2)},${fmt(y + h)}`,
        `${fmt(x)},${fmt(y + h / 2)}`,
      ].join(" ");
      return `<polygon points="${points}" ${stroke}/>`;
    }
    case "parallelogram": {
      const skew = Math.min(16, w / 5);
      const points = [
        `${fmt(x + skew)},${fmt(y)}`,
        `${fmt(x + w)},${fmt(y)}`,
        `${fmt(x + w - skew)},${fmt(y + h)}`,
        `${fmt(x)},${fmt(y + h)}`,
      ].join(" ");
      return `<polygon points="${points}" ${stroke}/>`;
    }
    case "cylinder": {
      const ry = Math.min(10, h / 5);
      const d =
        `M ${fmt(x)} ${fmt(y + ry)} ` +
        `A ${fmt(w / 2)} ${fmt(ry)} 0 0 1 ${fmt(x + w)} ${fmt(y + ry)} ` +
        `L ${fmt(x + w)} ${fmt(y + h - ry)} ` +
        `A ${fmt(w / 2)} ${fmt(ry)} 0 0 1 ${fmt(x)} ${fmt(y + h - ry)} Z`;
      return `<path d="${d}" ${stroke}/>`;
    }
    default:
      return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="2" ${stroke}/>`;
  }
}

function renderNodeText(node: FigureNode, p: { x: number; y: number; width: number; height: number }): string {
  if (isSymbolShape(node.shape)) return "";
  const lines = node.label.split("\n");
  const lineHeight = FIGURE_FONT_SIZE + 7;
  const startY = p.y + p.height / 2 - ((lines.length - 1) * lineHeight) / 2 + FIGURE_FONT_SIZE / 2 - 3;
  return lines
    .map(
      (line, i) =>
        `<text x="${fmt(p.x + p.width / 2)}" y="${fmt(startY + i * lineHeight)}" font-size="${FIGURE_FONT_SIZE}" ` +
        `text-anchor="middle" fill="#000000">${escapeXml(line)}</text>`,
    )
    .join("");
}

/**
 * 渲染单幅附图为完整 SVG 文档。
 *
 * `figureCount` 为本案附图总幅数（缺省 1）：图号是否需要标注由图幅数与法域档案共同决定
 * （见 `office-profile.ts` 的 `shouldRenderCaption`），核验器用同一判据量纸面尺寸。
 * 根元素写 `data-figure-no`：图号条件化后，机器回读（漂移检测）仍有无歧义的图号来源。
 */
export function renderFigureSvg(
  spec: FigureSpec,
  options: { jurisdiction?: Jurisdiction; figureCount?: number } = {},
): { svg: string; width: number; height: number } {
  const profile = profileForJurisdiction(options.jurisdiction);
  const caption = figureCaption(profile, spec.figure_no, options.figureCount ?? 1);
  const layout: FigureLayout = layoutFigure(spec, { caption: caption !== undefined });
  const { width, height } = layout;

  // 层级图的边表示包含关系（整体—组成部分），按惯用观感不画箭头；其余图型画箭头。
  const edgeMarker = spec.kind === "hierarchy" ? "" : ` marker-end="url(#arrow)"`;
  const edges = layout.edges
    .map(({ edge, points, labelAt }) => {
      const polyline =
        `<polyline fill="none" stroke="#000000" stroke-width="1.5"${edgeMarker} ` +
        (edge.dashed ? `stroke-dasharray="6 4" ` : "") +
        `points="${points.map(pt => `${fmt(pt.x)},${fmt(pt.y)}`).join(" ")}"/>`;
      const label =
        edge.label && labelAt
          ? `<text x="${fmt(labelAt.x)}" y="${fmt(labelAt.y)}" font-size="${EDGE_FONT_SIZE}" text-anchor="middle" ` +
            `fill="#000000" stroke="#FFFFFF" stroke-width="4" paint-order="stroke">${escapeXml(edge.label)}</text>`
          : "";
      return polyline + label;
    })
    .join("");

  const nodes = layout.nodes
    .map(p => {
      const shape = renderShape(p.node.shape ?? "rect", p);
      const text = renderNodeText(p.node, p);
      const refAttr = p.node.ref === undefined ? "" : ` data-ref="${p.node.ref}"`;
      return `<g id="n-${xmlId(p.node.id)}"${refAttr}>${shape}${text}</g>`;
    })
    .join("");

  const captionText =
    caption === undefined
      ? ""
      : `<text x="${fmt(width / 2)}" y="${fmt(height - 16)}" font-size="${FIGURE_FONT_SIZE}" ` +
        `text-anchor="middle" fill="#000000">${escapeXml(caption)}</text>\n`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ${FIGURE_NO_ATTRIBUTE}="${spec.figure_no}" ` +
    `width="${fmt(width)}" height="${fmt(height)}" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}" font-family="sans-serif">\n` +
    `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="#FFFFFF"/>\n` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,1 L9,5 L0,9 Z" fill="#000000"/></marker></defs>\n` +
    edges +
    nodes +
    captionText +
    `</svg>\n`;

  return { svg, width, height };
}
