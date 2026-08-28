/**
 * src/patent/figuregen — 附图 A4 打印版式（单文件 HTML）。
 *
 * 面向交付的打印 HTML：@page A4（边距 25/15mm 惯例，待与最终申请格式核对）、
 * 逐图分页、黑白约束（内嵌 SVG 已是黑白不变式输出）。PDF 由既有 Chromium
 * 打印管线（export_html / export-html.mjs）从此 HTML 产出。
 */

import { renderFigureSvg } from "./render-svg.js";
import type { FigureSpec } from "./types.js";

export type FiguresHtmlOptions = {
  /** 文档标题（<title> 与首页题头；通常为发明名称）。 */
  title?: string;
};

/** 渲染全部附图为可打印的单文件 HTML（A4 版式）。 */
export function renderFiguresHtml(specs: readonly FigureSpec[], options: FiguresHtmlOptions = {}): string {
  const title = options.title ?? "说明书附图";
  const sections = [...specs]
    .sort((a, b) => a.figure_no - b.figure_no)
    .map(spec => {
      const { svg } = renderFigureSvg(spec);
      return `  <section class="figure-page">\n  ${svg.trim()}\n  </section>`;
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
  .figure-page { page-break-after: always; text-align: center; }
  .figure-page:last-child { page-break-after: auto; }
  .figure-page svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
  <h1>${title}—说明书附图</h1>
${sections}
</body>
</html>
`;
}
