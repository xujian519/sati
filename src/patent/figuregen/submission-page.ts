/**
 * src/patent/figuregen — 提交落版页（单页 A4 版式，把图形落版到整幅页面）。
 *
 * 为什么要有这一步：`render-svg` / `dot` 出的是"图形自身的画布"（图号画在图形内部底部的
 * 标注带上），而提交/打印需要的是**整页视图**——图形居中落在法域档案的版心内、图号在图
 * 形正下方（指南一部一章 4.3「该编号应当标注在相应附图的正下方」）、页码在版心底部
 * （指南五部一章 5.6「页码应当置于每页下部页边的上沿，并左右居中」；PCT 行政规程
 * 207(b)(iii) 与 37 CFR 1.84(t) 为 `1/3` 体例）。
 *
 * 与姊妹项目 deepseek-harness 的有意差异：它把落版当作默认产物（`fit_to_page` 默认 true），
 * 因为它的工具只产一张图。Sati 的产物契约是 `<name>-figN.svg` + sidecar（`figure-gate` 依赖
 * 后者做漂移检测），默认改写画布会让既有调用方与门禁同时受冲击 ⇒ **Sati 的 `fit_to_page`
 * 默认 false**，落版页是**新增的附加产物**（`<name>-figN-page.svg`），图形 SVG 仍是机器可读的
 * 主产物。
 *
 * 版式是**确定性**的（无时钟/随机）：同样的输入产出逐字节相同的页面，便于快照与审阅。
 * 落版页可被 `parseFigureSvg` 回读（根元素带 `data-figure-no`，图号文本在页面层）——
 * `figure-gate` 的漂移检测因此对落版页同样有效。
 */

import { svgRootSizeMm } from "./html.js";
import { officeProfile, printableArea, sheetNumberText, type TargetOffice } from "./office-profile.js";
import { CSS_PX_PER_INCH, MM_PER_INCH, pxToMm } from "./page-contract.js";

/** 图内文字的默认估算字高（毫米）：内置渲染器 FIGURE_FONT_SIZE=14px。 */
const DEFAULT_SOURCE_CHAR_MM = (14 / CSS_PX_PER_INCH) * MM_PER_INCH;

export type SubmissionPageOptions = {
  /** 图形 SVG 文本（本模块渲染器的产物；png/pdf 不在 Sati 产物内，无需处理）。 */
  drawingSvg: string;
  office?: TargetOffice;
  /**
   * 页面层图号文本（`figureCaption` 的结果）。
   *
   * **通常不传**：本模块渲染器的图形已把图号画在图形正下方的标注带上（指南一部一章 4.3
   * 「该编号应当标注在相应附图的正下方」由图形自身满足），再画一个会出现两个图号。仅当
   * 调用方提供的图形**没有**图号、而页面又需要落图号时才传（例如外部产出的图形）。
   */
  caption?: string;
  /** 附图页序号 / 总页数（声明了才落页码；页码体例由档案决定）。 */
  sheetIndex?: number;
  sheetTotal?: number;
  /** 图号字号（毫米）；缺省 3.5mm（不低于三法域的字高下限 3.2mm）。 */
  captionFontMm?: number;
  /** 页码字号（毫米）；缺省 3.2mm。 */
  sheetFontMm?: number;
  /** 图形与图号之间的间距（毫米）；缺省 4mm。 */
  captionGapMm?: number;
  /** 放大上限（小图放大到失真没有意义）；缺省 4 倍，超限截断并出 warning。 */
  maxUpscale?: number;
  /**
   * 图形自身坐标下"图内文字"的字高（毫米）；缺省按内置渲染器的 14px 折算。
   * graphviz 产物以 pt 计，调用方可传 `pt→mm` 的结果，使字高估算与实际一致。
   */
  sourceCharHeightMm?: number;
};

export type SubmissionPageMetrics = {
  /** 图形落到版心的缩放系数（>1 表示放大）。 */
  pageScale: number;
  /** 图形自身画幅（毫米）。 */
  drawingWidthMm: number;
  drawingHeightMm: number;
  /** 落版后图形的纸面尺寸（毫米）。 */
  placedWidthMm: number;
  placedHeightMm: number;
  /** 图内文字落版后的纸面字高（毫米，估算）。 */
  charHeightMm: number;
  /** 再缩 2/3 后的字高（毫米，估算）——判"缩小到三分之二仍可辨"的输入。 */
  reducedCharHeightMm: number;
  /** 图号基线 y（毫米）；未画图号时缺省。 */
  captionBaselineMm?: number;
  /** 页码基线 y（毫米）；未落页码时缺省。 */
  sheetBaselineMm?: number;
};

export type SubmissionPageResult = {
  svg: string;
  metrics: SubmissionPageMetrics;
  /** 版式告警（不阻断：落版页是附加产物，交付判定仍由核验器负责）。 */
  warnings: string[];
};

/** 图形画幅（毫米）：先读 width/height 声明，缺失时回落 viewBox（按 CSS px 折算）。 */
function drawingSizeMm(svg: string): { widthMm: number; heightMm: number } {
  const declared = svgRootSizeMm(svg);
  if (declared !== undefined) return declared;
  const viewBox = svg.match(/<svg\b[^>]*\bviewBox="[\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/u);
  if (viewBox !== null) {
    const width = Number(viewBox[1]);
    const height = Number(viewBox[2]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { widthMm: pxToMm(width), heightMm: pxToMm(height) };
    }
  }
  throw new TypeError("图形 SVG 缺少可解析的 width/height 与 viewBox，无法落版");
}

/** 把图形 SVG 改写为父坐标系下的嵌套 `<svg>`（去掉自己的 xmlns 与宽高，改由父级定位）。 */
function nestDrawing(svg: string, placed: { xMm: number; yMm: number; widthMm: number; heightMm: number }): string {
  const rootMatch = svg.match(/<svg\b([^>]*)>/u);
  if (rootMatch === null) {
    throw new TypeError("图形 SVG 缺少 <svg 根元素");
  }
  const attrs = rootMatch[1];
  const viewBox = attrs.match(/\bviewBox="([^"]*)"/u)?.[1];
  const inner = svg.slice((rootMatch.index ?? 0) + rootMatch[0].length).replace(/<\/svg>\s*$/u, "");
  const kept = [`x="${placed.xMm.toFixed(2)}"`, `y="${placed.yMm.toFixed(2)}"`];
  const size = [`width="${placed.widthMm.toFixed(2)}"`, `height="${placed.heightMm.toFixed(2)}"`];
  const vb = viewBox === undefined ? [] : [`viewBox="${viewBox}"`];
  return `<svg ${[...kept, ...size, ...vb].join(" ")} preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

/** 图形 SVG 的图号属性（若有）原样带到页面上：落版页因此同样可被 `parseFigureSvg` 回读。 */
function figureNoAttribute(drawingSvg: string): string {
  const match = drawingSvg.match(/\bdata-figure-no="(\d+)"/u);
  return match === null ? "" : `data-figure-no="${match[1]}" `;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * 生成提交落版页（单页 A4，图形居中 + 图号在图下 + 页码在版心底）。
 *
 * 图号与页码文本由调用方经 `figureCaption` / `sheetNumberText` 取得——本模块**不自行解释**
 * 编号与页码规则（那两处是法域档案的职责，两处各解释一次必然漂移）。
 */
export function buildSubmissionPage(options: SubmissionPageOptions): SubmissionPageResult {
  const profile = officeProfile(options.office ?? "cnipa");
  const area = printableArea(profile);
  const captionFontMm = options.captionFontMm ?? 3.5;
  const sheetFontMm = options.sheetFontMm ?? 3.2;
  const captionGapMm = options.captionGapMm ?? 4;
  const maxUpscale = options.maxUpscale ?? 4;
  const warnings: string[] = [];

  const drawing = drawingSizeMm(options.drawingSvg);
  const sheetText =
    options.sheetIndex === undefined || options.sheetTotal === undefined
      ? undefined
      : sheetNumberText(profile, options.sheetIndex, options.sheetTotal);
  if (options.caption !== undefined && options.caption.trim().length === 0) {
    throw new TypeError("图号文本为空字符串：需要图号请传 figureCaption 的结果，不需要则不传");
  }

  const captionBandMm = options.caption === undefined ? 0 : captionGapMm + captionFontMm;
  const sheetBandMm = sheetText === undefined ? 0 : sheetFontMm + 2;
  const drawingAreaHeightMm = area.heightMm - captionBandMm - sheetBandMm;
  if (drawingAreaHeightMm <= 0) {
    throw new TypeError(`版心不足以容纳图形与图号/页码（${profile.office} 版心高 ${area.heightMm}mm）`);
  }

  const fit = Math.min(area.widthMm / drawing.widthMm, drawingAreaHeightMm / drawing.heightMm);
  const pageScale = Math.min(fit, maxUpscale);
  if (fit > maxUpscale) {
    warnings.push(
      `图形仅 ${drawing.widthMm.toFixed(1)}×${drawing.heightMm.toFixed(1)}mm，按上限放大 ${maxUpscale}×` +
        `（原可放大 ${fit.toFixed(1)}×）——过放大会让线条与文字失真`,
    );
  }
  if (fit < 1) {
    warnings.push(
      `图形 ${drawing.widthMm.toFixed(1)}×${drawing.heightMm.toFixed(1)}mm 超出 ${profile.office} 版心` +
        ` ${area.widthMm.toFixed(1)}×${area.heightMm.toFixed(1)}mm，落版缩放至 ${(fit * 100).toFixed(0)}%`,
    );
  }

  const placed = { widthMm: drawing.widthMm * pageScale, heightMm: drawing.heightMm * pageScale };
  const drawingX = (area.widthMm - placed.widthMm) / 2 + profile.margins.leftMm;
  const drawingY = (drawingAreaHeightMm - placed.heightMm) / 2 + profile.margins.topMm;
  const captionBaselineMm =
    options.caption === undefined
      ? undefined
      : profile.margins.topMm + drawingAreaHeightMm + captionGapMm + captionFontMm * 0.85;
  const sheetBaselineMm = sheetText === undefined ? undefined : profile.paper.heightMm - profile.margins.bottomMm;

  const sourceCharMm = options.sourceCharHeightMm ?? DEFAULT_SOURCE_CHAR_MM;
  const charHeightMm = sourceCharMm * pageScale;

  const textMarkup = (text: string, baselineMm: number, fontMm: number): string =>
    `<text x="${fmt(profile.paper.widthMm / 2)}" y="${fmt(baselineMm)}" font-size="${fmt(fontMm)}" ` +
    `text-anchor="middle" fill="#000000">${escapeXml(text)}</text>\n`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ${figureNoAttribute(options.drawingSvg)}` +
    `width="${fmt(profile.paper.widthMm)}mm" ` +
    `height="${fmt(profile.paper.heightMm)}mm" ` +
    `viewBox="0 0 ${fmt(profile.paper.widthMm)} ${fmt(profile.paper.heightMm)}" ` +
    `font-family="sans-serif"\n` +
    `<rect x="0" y="0" width="${fmt(profile.paper.widthMm)}" height="${fmt(profile.paper.heightMm)}" fill="#FFFFFF"/>\n` +
    `${nestDrawing(options.drawingSvg, { xMm: drawingX, yMm: drawingY, ...placed })}\n` +
    (captionBaselineMm === undefined || options.caption === undefined
      ? ""
      : textMarkup(options.caption, captionBaselineMm, captionFontMm)) +
    (sheetBaselineMm === undefined || sheetText === undefined
      ? ""
      : textMarkup(sheetText, sheetBaselineMm, sheetFontMm)) +
    `</svg>\n`;

  return {
    svg,
    metrics: {
      pageScale,
      drawingWidthMm: drawing.widthMm,
      drawingHeightMm: drawing.heightMm,
      placedWidthMm: placed.widthMm,
      placedHeightMm: placed.heightMm,
      charHeightMm,
      reducedCharHeightMm: charHeightMm * profile.reductionRatio,
      ...(captionBaselineMm === undefined ? {} : { captionBaselineMm }),
      ...(sheetBaselineMm === undefined ? {} : { sheetBaselineMm }),
    },
    warnings,
  };
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
