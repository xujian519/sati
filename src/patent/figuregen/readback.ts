/**
 * src/patent/figuregen — 已交付 SVG 回读解析。
 *
 * 仅保证解析本模块两类渲染器的输出：
 * - render-svg（内置）：节点分组 id 形如 "n-<nodeId>"，data-ref 在分组属性上，
 *   首个 <text> 为 label 首行，居中"图N"标注；
 * - render-graphviz（Graphviz）：节点分组带 class="node"，原节点 id 在
 *   <title> 内，data-ref 由 postProcessGraphvizSvg 注入，图号标注为图尾
 *   <text>（"图N" / "FIG. N"）。
 * 外部工具产出的 SVG 不在此契约内。
 */

import type { FigureNode } from "./types.js";

export type ParsedFigureSvg = {
  figureNo: number;
  nodes: FigureNode[];
};

function unescapeXml(text: string): string {
  // 数字实体先行（如 graphviz 边名的 &#45;）；命名实体 &amp; 必须最后展开，
  // 保证字面量 "&#45;" 只被解码一层。
  const numericFirst = text.replaceAll(/&#(\d+);/gu, (_match, code: string) => String.fromCharCode(Number(code)));
  return numericFirst
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * 解析单幅本模块渲染的 SVG。缺"图N"/"FIG. N"标注时抛错（外部 SVG 不在契约内）。
 * 图号取最后一个 text 标注（两个渲染器都把 caption 放在图尾，避免节点文本
 * 恰好含"图N"字样时误配）。
 */
export function parseFigureSvg(svg: string): ParsedFigureSvg {
  const captions = [...svg.matchAll(/<text[^>]*>(?:FIG\.\s*|图)(\d+)<\/text>/gu)];
  const caption = captions[captions.length - 1];
  if (!caption) {
    throw new TypeError("SVG 缺少'图N'图号标注：仅支持解析 patent_figure_generate 产出的附图");
  }
  const figureNo = Number(caption[1]);

  const nodes: FigureNode[] = [];
  // 深度追踪扫描（graph0 分组包裹全部节点/边分组，惰性正则会把首个子分组
  // 误吞进外层部分匹配）：栈式配对 <g>/</g>，闭合时取该分组的真实内容。
  const tagPattern = /<(\/?)g\b([^>]*)>/gu;
  const stack: { attrs: string; contentStart: number }[] = [];
  for (const match of svg.matchAll(tagPattern)) {
    const [, closeSlash, rawAttrs] = match;
    if (closeSlash === "") {
      stack.push({ attrs: rawAttrs, contentStart: (match.index ?? 0) + match[0].length });
      continue;
    }
    const open = stack.pop();
    if (!open) {
      continue;
    }
    // graph0/graph 分组与 edge 分组不是节点：内置渲染器分组 id 形如 "n-<nodeId>"，
    // graphviz 节点分组带 class="node"；其余（graph/edge）跳过。
    const idAttr = open.attrs.match(/\bid="([^"]*)"/u);
    const builtinId = idAttr?.[1];
    const isBuiltinGroup = builtinId?.startsWith("n-") === true;
    const isGraphNode = open.attrs.includes('class="node"');
    if (!isBuiltinGroup && !isGraphNode) {
      continue;
    }
    const body = svg.slice(open.contentStart, match.index ?? 0);
    const refMatch = open.attrs.match(/data-ref="(\d+)"/u);
    const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/u);
    const textMatch = body.match(/<text[^>]*>([\s\S]*?)<\/text>/u);
    // 内置渲染器：id = 去掉 "n-" 前缀；graphviz：原节点 id 在 <title> 内。
    const id = titleMatch
      ? unescapeXml(titleMatch[1])
      : isBuiltinGroup
        ? (builtinId ?? "").slice(2)
        : (builtinId ?? "");
    // tspan 容错：dot 多行 label 每行一个 <text>，剥掉可能存在的内层标签取首行。
    const label = textMatch ? unescapeXml(textMatch[1].replaceAll(/<[^>]*>/gu, "")) : "";
    nodes.push({
      id,
      label,
      ...(refMatch ? { ref: Number(refMatch[1]) } : {}),
    });
  }
  return { figureNo, nodes };
}
