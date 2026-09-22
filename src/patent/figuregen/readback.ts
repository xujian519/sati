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
 *
 * 调用方纪律：凡是**跨信任边界读盘**得到的 SVG（用户提供、第三方工具产出、被人工改过），
 * 必须先过 `svg-safety.ts` 的 `assertSafeSvg` 再进入本解析器——本模块只解析，不设安全边界。
 *
 * 图号来源两处（先属性后文本）：图号自 2026-09-22 起**条件化**（单幅在 PCT/US 不得出现
 * "Fig."/"FIG."），故渲染器在根元素写 `data-figure-no`（`FIGURE_NO_ATTRIBUTE`）作为回读的
 * 权威来源；文本标注作为回落，使旧产物与历史案卷仍可回读。`numbered` 报告"是否带可见图号"，
 * 供核验器判 V15/V16（编号义务是可见形态的要求，属性是机器契约，两者不可混同）。
 */

import type { FigureNode } from "./types.js";

/** 根元素上的图号属性（渲染器写入、回读优先取它）。 */
export const FIGURE_NO_ATTRIBUTE = "data-figure-no";

export type ParsedFigureSvg = {
  figureNo: number;
  nodes: FigureNode[];
  /** 是否带**可见**图号标注（属性不算；供 V15/V16 判定可见形态）。 */
  numbered: boolean;
};

/**
 * 在根 `<svg>` 上写入图号属性（graphviz 等外部渲染器加工后调用，把"机器可读的图号"
 * 补齐到与本模块内置渲染器同一契约）。
 */
export function withFigureNumberAttribute(svg: string, figureNo: number): string {
  if (new RegExp(`\\b${FIGURE_NO_ATTRIBUTE}="`, "u").test(svg)) {
    return svg;
  }
  const rootEnd = svg.indexOf(">", svg.indexOf("<svg"));
  if (rootEnd === -1) {
    throw new TypeError("SVG 缺少 <svg 根元素标签的结束符");
  }
  return `${svg.slice(0, rootEnd)} ${FIGURE_NO_ATTRIBUTE}="${figureNo}"${svg.slice(rootEnd)}`;
}

/**
 * XML 文本反转义（含数字实体）。
 *
 * 数字实体必须先行：graphviz 在 `<title>` 里把 `-` 写成 `&#45;`（避免 `--` 破坏 XML 注释），
 * 节点 id 是 `f1-n1` 这类形态时，不解码就永远匹配不上。
 */
export function unescapeXml(text: string): string {
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
 * 解析单幅本模块渲染的 SVG。图号取根元素属性 `data-figure-no`，缺失时回落到图尾的可见
 * 标注（"图N" / "FIG. N"，两个渲染器都把 caption 放在图尾，避免节点文本恰好含"图N"
 * 字样时误配）；两者都没有才抛错。
 */
export function parseFigureSvg(svg: string): ParsedFigureSvg {
  const attribute = svg.match(new RegExp(`\\b${FIGURE_NO_ATTRIBUTE}="(\\d+)"`, "u"));
  const captions = [...svg.matchAll(/<text[^>]*>(?:FIG\.\s*|Fig\.\s*|图)(\d+)<\/text>/gu)];
  const caption = captions[captions.length - 1];
  const figureNo = attribute ? Number(attribute[1]) : caption ? Number(caption[1]) : undefined;
  if (figureNo === undefined) {
    throw new TypeError(
      `SVG 缺少图号（${FIGURE_NO_ATTRIBUTE} 属性与"图N"标注均缺失）：仅支持解析 patent_figure_generate 产出的附图`,
    );
  }

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
  return { figureNo, nodes, numbered: caption !== undefined };
}
