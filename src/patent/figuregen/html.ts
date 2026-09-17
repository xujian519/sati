/**
 * src/patent/figuregen — 附图 A4 打印版式（单文件 HTML）。
 *
 * 面向交付的打印 HTML：@page A4（边距与 `page-contract.ts` 同源——核验器 V7 的
 * 可印区判据与这里的实际版式必须一致，否则阈值会与实际排版漂移）、逐图分页、
 * 黑白约束（内嵌 SVG 已是黑白不变式输出）。PDF 由既有 Chromium 打印管线
 * （export_html / export-html.mjs）从此 HTML 产出。
 *
 * 版式约束（修正"只压宽不压高"导致纵向溢出被分页切断）：
 * ① 以 SVG 根元素声明的画幅（CSS px / pt / mm，单位归一）换算纸面毫米；
 * ② 全文档**统一缩放系数**（`uniformFigureZoom`）——逐图独立缩放会让同一说明书的
 *    字高不一致（大图字小、小图字大）；
 * ③ `max-height` + `break-inside: avoid` 兜底：不可解析画幅时仍不溢出、不跨页切断。
 */

import {
  CSS_PX_PER_INCH,
  MM_PER_INCH,
  PRINTABLE_HEIGHT_MM,
  type FigurePaperSize,
  uniformFigureZoom,
} from "./page-contract.js";
import { renderFigureSvg } from "./render-svg.js";
import type { FigureSpec, Jurisdiction } from "./types.js";

export type FiguresHtmlOptions = {
  /** 文档标题（<title> 与首页题头；通常为发明名称）。 */
  title?: string;
  /** 辖区（默认 cn）：us 时内嵌 SVG 图号标注为 FIG. N。 */
  jurisdiction?: Jurisdiction;
  /** 预渲染 SVG（figure_no → svg 文本）：graphviz 等异步渲染器先出图再排版的注入点；
   * 缺省图走内置 renderFigureSvg。 */
  renderedSvgs?: ReadonlyMap<number, string>;
};

/** SVG 长度单位 → 毫米（无单位 = CSS px：1in = 96px = 25.4mm）。 */
const LENGTH_UNIT_MM: Record<string, number> = {
  "": MM_PER_INCH / CSS_PX_PER_INCH,
  px: MM_PER_INCH / CSS_PX_PER_INCH,
  pt: MM_PER_INCH / 72,
  mm: 1,
  cm: 10,
  in: MM_PER_INCH,
};

function parseLengthMm(rootTag: string, attr: string): number | undefined {
  const match = rootTag.match(new RegExp(`\\b${attr}="([\\d.]+)\\s*([a-z%]*)"`, "u"));
  if (match === null) return undefined;
  const factor = LENGTH_UNIT_MM[match[2].toLowerCase()];
  if (factor === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value * factor : undefined;
}

/**
 * 解析 SVG 根元素声明画幅（纸面毫米）。
 *
 * 内置渲染器输出无单位宽高（CSS px），graphviz 输出带 `pt`——两者必须按各自单位
 * 归一，否则同一缩放系数下 graphviz 图会被放大 4/3。缺声明或单位不可识别时返回
 * undefined（调用方走 CSS 兜底，不猜测）。
 */
export function svgRootSizeMm(svg: string): FigurePaperSize | undefined {
  const rootTag = svg.match(/<svg\b[^>]*>/u)?.[0];
  if (rootTag === undefined) return undefined;
  const widthMm = parseLengthMm(rootTag, "width");
  const heightMm = parseLengthMm(rootTag, "height");
  if (widthMm === undefined || heightMm === undefined) return undefined;
  return { widthMm, heightMm };
}

/** 渲染全部附图为可打印的单文件 HTML（A4 版式）。 */
export function renderFiguresHtml(specs: readonly FigureSpec[], options: FiguresHtmlOptions = {}): string {
  const title = options.title ?? "说明书附图";
  const entries = [...specs]
    .sort((a, b) => a.figure_no - b.figure_no)
    .map(spec => {
      const preRendered = options.renderedSvgs?.get(spec.figure_no);
      const svg = preRendered ?? renderFigureSvg(spec, { jurisdiction: options.jurisdiction }).svg;
      return { spec, svg, size: svgRootSizeMm(svg) };
    });

  const zoom = uniformFigureZoom(entries.flatMap(entry => (entry.size === undefined ? [] : [entry.size])));

  const sections = entries
    .map(entry => {
      const boxClass = entry.size === undefined ? "figure-box figure-box-auto" : "figure-box";
      const sized = entry.size === undefined ? "" : ` style="width: ${(entry.size.widthMm * zoom).toFixed(1)}mm"`;
      return (
        `  <section class="figure-page">\n` +
        `  <div class="${boxClass}"${sized}>\n  ${entry.svg.trim()}\n  </div>\n` +
        `  </section>`
      );
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}—说明书附图</title>
<style>
  @page { size: A4; margin: 25mm 15mm 15mm 25mm; }
  html, body { background: #FFFFFF; color: #000000; font-family: sans-serif; margin: 0; padding: 0; }
  h1 { font-size: 16pt; text-align: center; font-weight: normal; margin: 12mm 0 8mm; }
  .figure-page { page-break-after: always; break-inside: avoid; text-align: center; }
  .figure-page:last-child { page-break-after: auto; }
  .figure-box { display: inline-block; max-width: 100%; }
  .figure-box svg { display: block; width: 100%; height: auto; max-height: ${PRINTABLE_HEIGHT_MM}mm; }
  .figure-box-auto svg { width: auto; max-width: 100%; }
</style>
</head>
<body>
  <h1>${title}—说明书附图</h1>
${sections}
</body>
</html>
`;
}
