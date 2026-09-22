/**
 * src/patent/figuregen — 打印版式物理契约（核验器与渲染器的**单一事实源**）。
 *
 * 附图交付物是打印稿，"缩小到三分之二仍可辨"（指南一部一章 4.3）只有换算到纸面毫米才有
 * 意义：故 V7（`check.ts`）、HTML 版式（`html.ts`）、栅格门（`pixel-gate.ts`）与落版页
 * （`submission-page.ts`）必须共用同一套纸张/边距/字高判据，否则核验阈值与实际排版各自漂移。
 *
 * 法域化（2026-09-22）：纸面常数不再是"实践惯例"式的一组硬编码，而是取自 `office-profile.ts`
 * 的**已核验条文**（CN 指南五部一章 4.2/4.3、PCT Rule 11.5/11.6(c)、37 CFR 1.84(f)(1)/(g)）。
 * 本模块保留 `DEFAULT_OFFICE`（cnipa）的派生常量，让既有调用方过渡期不必一次性全改；
 * **新代码一律按档案取值**（`printableArea` / `uniformFigureZoom` 的 profile 参数）。
 */

import { DEFAULT_OFFICE_PROFILE, type OfficeProfile, printableArea } from "./office-profile.js";

/** SVG 的 width/height 无单位时为 CSS px（1in = 96px）。 */
export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;

/** CSS px → 毫米（附图内部坐标即 CSS px）。 */
export function pxToMm(px: number): number {
  return (px / CSS_PX_PER_INCH) * MM_PER_INCH;
}

/** 默认法域档案（未声明辖区时的取值；与 office-profile 的 cnipa 同源）。 */
export const DEFAULT_OFFICE: OfficeProfile["office"] = DEFAULT_OFFICE_PROFILE.office;

/** 用纸尺寸（mm，默认法域）。已核验三法域均为 A4，故这里是 A4 的别名。 */
export const A4_WIDTH_MM = DEFAULT_OFFICE_PROFILE.paper.widthMm;
export const A4_HEIGHT_MM = DEFAULT_OFFICE_PROFILE.paper.heightMm;

/** 页边距（mm，默认法域档案值）：与 html.ts 的 @page margin 同源。 */
export const PAGE_MARGIN_TOP_MM = DEFAULT_OFFICE_PROFILE.margins.topMm;
export const PAGE_MARGIN_RIGHT_MM = DEFAULT_OFFICE_PROFILE.margins.rightMm;
export const PAGE_MARGIN_BOTTOM_MM = DEFAULT_OFFICE_PROFILE.margins.bottomMm;
export const PAGE_MARGIN_LEFT_MM = DEFAULT_OFFICE_PROFILE.margins.leftMm;

/** 可印区（mm，默认法域档案派生）：210 − 25 − 15 = 170 宽；297 − 25 − 15 = 257 高。 */
export const PRINTABLE_WIDTH_MM = printableArea(DEFAULT_OFFICE_PROFILE).widthMm;
export const PRINTABLE_HEIGHT_MM = printableArea(DEFAULT_OFFICE_PROFILE).heightMm;

/**
 * 打印后最小可辨字高（mm）——默认法域的**实践下限**（CN 无"附图中文字"的条文数值，
 * 见 office-profile.ts 头注第 3 条）。按法域判定请走档案：`minCharHeight(profile)`。
 */
export const MIN_PRINTED_FONT_MM = DEFAULT_OFFICE_PROFILE.practicalMinCharHeightMm ?? 2;

/** 三分之二规则（指南一部一章 4.3 / PCT Rule 11.13(c) / 37 CFR 1.84(k)）：三法域同为 2/3。 */
export const LEGIBILITY_SHRINK_FACTOR = DEFAULT_OFFICE_PROFILE.reductionRatio;

/** 图幅纸面尺寸（mm）。 */
export type FigurePaperSize = {
  widthMm: number;
  heightMm: number;
};

/**
 * 同文档统一缩放系数 = min(1, 各图版心宽/图宽, 各图版心高/图高)。
 *
 * 逐图独立缩放会让同文档字高不一致（大图字小、小图字大）。统一系数使
 * ① 打印版式各图缩放一致；② 核验器报告的打印字高与实际排版一致（而非按
 * 单图缩放高估字高）。空列表返回 1（无缩放）。
 */
export function uniformFigureZoom(
  sizes: readonly FigurePaperSize[],
  profile: OfficeProfile = DEFAULT_OFFICE_PROFILE,
): number {
  const area = printableArea(profile);
  let zoom = 1;
  for (const size of sizes) {
    if (size.widthMm > 0) zoom = Math.min(zoom, area.widthMm / size.widthMm);
    if (size.heightMm > 0) zoom = Math.min(zoom, area.heightMm / size.heightMm);
  }
  return zoom;
}

/** 缩放后落在纸面上的字高（mm）。 */
export function printedFontMm(fontPx: number, zoom: number): number {
  return pxToMm(fontPx) * zoom;
}
