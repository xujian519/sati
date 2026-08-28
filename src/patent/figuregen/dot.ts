/**
 * src/patent/figuregen — FigureSpec → Graphviz DOT 源（确定性纯函数）。
 *
 * Graphviz 可选渲染器（复杂大图增强）的第一段：同输入永远产出同一 DOT 文本
 * （快照测试前提）。黑白合规（指南一部一章 4.3/4.6）在 DOT 层即已固化：
 * 仅 #000000/#FFFFFF、无渐变、无彩色函数；颜色统一写十六进制，使 dot 的
 * SVG 输出可直接过黑白不变式扫描。节点 id 以带引号 DOT id 原样传递，
 * graphviz 会把它写进 SVG <title>，供 data-ref 注入与 readback 回读。
 */

import { figureCaption } from "./render-svg.js";
import type { FigureNode, FigureNodeShape, FigureSpec, Jurisdiction } from "./types.js";

const FONT_SIZE = 14;
const EDGE_FONT_SIZE = 12;

const DOT_SHAPE: Readonly<Record<FigureNodeShape, { shape: string; style?: string }>> = {
  rect: { shape: "box" },
  round: { shape: "box", style: "rounded,filled" },
  diamond: { shape: "diamond" },
  ellipse: { shape: "ellipse" },
  cylinder: { shape: "cylinder" },
  parallelogram: { shape: "parallelogram" },
};

/** DOT 带引号字符串转义：反斜杠、引号与换行（换行写作 \n 字面量，dot 出多行文本）。 */
export function dotEscape(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r\n", "\n").replaceAll("\n", "\\n");
}

/** 节点文本：graphviz 在 SVG 文本内容里仅转义 & < >。 */
function escapeXmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function nodeAttrs(node: FigureNode): string {
  const { shape, style } = DOT_SHAPE[node.shape ?? "rect"];
  const attrs = [`label="${dotEscape(node.label)}"`, `shape="${shape}"`];
  if (style !== undefined) {
    attrs.push(`style="${style}"`);
  }
  return attrs.join(", ");
}

/** 渲染单幅附图为 DOT 源（确定性，同 FigureSpec 逐字节一致）。 */
export function buildFigureDot(spec: FigureSpec, options: { jurisdiction?: Jurisdiction } = {}): string {
  const direction = spec.direction ?? (spec.kind === "block" ? "LR" : "TB");
  const lines: string[] = [
    "digraph {",
    '  bgcolor="#FFFFFF";',
    `  rankdir="${direction}";`,
    `  label="${dotEscape(figureCaption(spec.figure_no, options.jurisdiction))}";`,
    '  labelloc="b";',
    '  fontname="sans-serif";',
    `  fontsize=${FONT_SIZE};`,
    '  node [fontname="sans-serif", fontsize=14, style="filled", fillcolor="#FFFFFF", color="#000000", fontcolor="#000000"];',
    `  edge [fontname="sans-serif", fontsize=${EDGE_FONT_SIZE}, color="#000000", fontcolor="#000000"];`,
  ];
  for (const node of spec.nodes) {
    lines.push(`  "${dotEscape(node.id)}" [${nodeAttrs(node)}];`);
  }
  for (const edge of spec.edges) {
    const attrs: string[] = [];
    if (edge.label !== undefined) {
      attrs.push(`label="${dotEscape(edge.label)}"`);
    }
    if (edge.dashed === true) {
      attrs.push("style=dashed");
    }
    const suffix = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
    lines.push(`  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}"${suffix};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/** 供测试断言 title 匹配口径：graphviz SVG 文本内容转义后的节点 id。 */
export function dotNodeTitle(nodeId: string): string {
  return escapeXmlText(nodeId);
}
