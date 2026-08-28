/**
 * src/patent/figuregen — 专利附图 SVG 渲染器（构造期合规）。
 *
 * 审查指南 2023 一部一章 4.3/4.6 的黑白合规是构造期不变式：仅 #000000/#FFFFFF、
 * 无渐变、无彩色函数；文字黑色背景白净。附图标记写入节点分组的 data-ref 属性
 * （供核验器/代理师工具回读），文本层同时渲染"组件名(N)"惯用形。图号"图N"按
 * 细则第 21 条式样居中标注于图下方。输出确定性：无时钟/随机/ locale 依赖。
 */

import { layoutFigure, type FigureLayout } from "./layout.js";
import type { FigureNode, FigureNodeShape, FigureSpec } from "./types.js";

const FONT_SIZE = 14;
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

function renderShape(shape: FigureNodeShape, p: { x: number; y: number; width: number; height: number }): string {
  const { x, y, width: w, height: h } = p;
  const stroke = 'fill="#FFFFFF" stroke="#000000" stroke-width="1.5"';
  switch (shape) {
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
  const lines = node.label.split("\n");
  const lineHeight = FONT_SIZE + 7;
  const startY = p.y + p.height / 2 - ((lines.length - 1) * lineHeight) / 2 + FONT_SIZE / 2 - 3;
  return lines
    .map(
      (line, i) =>
        `<text x="${fmt(p.x + p.width / 2)}" y="${fmt(startY + i * lineHeight)}" font-size="${FONT_SIZE}" ` +
        `text-anchor="middle" fill="#000000">${escapeXml(line)}</text>`,
    )
    .join("");
}

/** 渲染单幅附图为完整 SVG 文档。 */
export function renderFigureSvg(spec: FigureSpec): { svg: string; width: number; height: number } {
  const layout: FigureLayout = layoutFigure(spec);
  const { width, height } = layout;

  const edges = layout.edges
    .map(({ edge, points, labelAt }) => {
      const polyline =
        `<polyline fill="none" stroke="#000000" stroke-width="1.5" marker-end="url(#arrow)" ` +
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

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}" font-family="sans-serif">\n` +
    `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="#FFFFFF"/>\n` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,1 L9,5 L0,9 Z" fill="#000000"/></marker></defs>\n` +
    edges +
    nodes +
    `<text x="${fmt(width / 2)}" y="${fmt(height - 16)}" font-size="${FONT_SIZE}" text-anchor="middle" fill="#000000">` +
    `图${spec.figure_no}</text>\n` +
    `</svg>\n`;

  return { svg, width, height };
}
