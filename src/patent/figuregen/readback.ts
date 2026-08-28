/**
 * src/patent/figuregen — 已交付 SVG 回读解析。
 *
 * 仅保证解析本模块 render-svg 的输出：节点分组的 data-ref 属性、首个 <text>
 * 作为 label 首行、居中"图N"标注。外部工具产出的 SVG 不在此契约内。
 */

import type { FigureNode } from "./types.js";

export type ParsedFigureSvg = {
  figureNo: number;
  nodes: FigureNode[];
};

function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** 解析单幅本模块渲染的 SVG。缺"图N"标注时抛错（外部 SVG 不在契约内）。 */
export function parseFigureSvg(svg: string): ParsedFigureSvg {
  const captionMatch = svg.match(/<text[^>]*>图(\d+)<\/text>/u);
  if (!captionMatch) {
    throw new TypeError("SVG 缺少'图N'图号标注：仅支持解析 patent_figure_generate 产出的附图");
  }
  const figureNo = Number(captionMatch[1]);

  const nodes: FigureNode[] = [];
  const groupPattern = /<g id="([^"]*)"([^>]*)>([\s\S]*?)<\/g>/gu;
  for (const match of svg.matchAll(groupPattern)) {
    const [, rawId, rawAttrs, body] = match;
    const refMatch = rawAttrs.match(/data-ref="(\d+)"/u);
    const textMatch = body.match(/<text[^>]*>([^<]*)<\/text>/u);
    nodes.push({
      id: rawId.replace(/^n-/u, ""),
      label: textMatch ? unescapeXml(textMatch[1]) : "",
      ...(refMatch ? { ref: Number(refMatch[1]) } : {}),
    });
  }
  return { figureNo, nodes };
}
