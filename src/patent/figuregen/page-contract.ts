/**
 * src/patent/figuregen — A4 打印版式物理契约（核验器与渲染器的**单一事实源**）。
 *
 * 附图交付物是 A4 打印稿，"缩小到三分之二仍可辨"（指南一部一章 4.3）只有换算到
 * 纸面毫米才有意义：故 V7（`check.ts`）与 HTML 版式（`html.ts`）必须共用本模块
 * 的纸张常量与缩放系数，否则核验阈值与实际排版会各自漂移。
 *
 * 边距为实践惯例（上 25 / 右 15 / 下 15 / 左 25mm）——正式提交前由代理师按最终
 * 申请格式复核，本模块只保证"核验判据与渲染版式同源"。
 */

/** SVG 的 width/height 无单位时为 CSS px（1in = 96px）。 */
export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;

/** CSS px → 毫米（附图内部坐标即 CSS px）。 */
export function pxToMm(px: number): number {
  return (px / CSS_PX_PER_INCH) * MM_PER_INCH;
}

/** A4 纸张尺寸（mm）。 */
export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

/** 页边距（mm）：与 html.ts 的 @page margin 同源。 */
export const PAGE_MARGIN_TOP_MM = 25;
export const PAGE_MARGIN_RIGHT_MM = 15;
export const PAGE_MARGIN_BOTTOM_MM = 15;
export const PAGE_MARGIN_LEFT_MM = 25;

/** A4 可印区（mm）：210 − 25 − 15 = 170 宽；297 − 25 − 15 = 257 高。 */
export const PRINTABLE_WIDTH_MM = A4_WIDTH_MM - PAGE_MARGIN_LEFT_MM - PAGE_MARGIN_RIGHT_MM;
export const PRINTABLE_HEIGHT_MM = A4_HEIGHT_MM - PAGE_MARGIN_TOP_MM - PAGE_MARGIN_BOTTOM_MM;

/** 打印后最小可辨字高（mm）：低于此值的图内文字在纸面上难以辨认。 */
export const MIN_PRINTED_FONT_MM = 2.0;

/** 三分之二规则（指南一部一章 4.3）：再缩到 2/3 仍应可辨。 */
export const LEGIBILITY_SHRINK_FACTOR = 2 / 3;

/** 图幅纸面尺寸（mm）。 */
export type FigurePaperSize = {
  widthMm: number;
  heightMm: number;
};

/**
 * 同文档统一缩放系数 = min(1, 各图可印宽/图宽, 各图可印高/图高)。
 *
 * 逐图独立缩放会让同文档字高不一致（大图字小、小图字大）。统一系数使
 * ① HTML 版式各图缩放一致；② 核验器报告的打印字高与实际排版一致（而非按
 * 单图缩放高估字高）。空列表返回 1（无缩放）。
 */
export function uniformFigureZoom(sizes: readonly FigurePaperSize[]): number {
  let zoom = 1;
  for (const size of sizes) {
    if (size.widthMm > 0) zoom = Math.min(zoom, PRINTABLE_WIDTH_MM / size.widthMm);
    if (size.heightMm > 0) zoom = Math.min(zoom, PRINTABLE_HEIGHT_MM / size.heightMm);
  }
  return zoom;
}

/** 缩放后落在纸面上的字高（mm）。 */
export function printedFontMm(fontPx: number, zoom: number): number {
  return pxToMm(fontPx) * zoom;
}
