/**
 * src/patent/figuregen — 专利附图生成模块 barrel。
 *
 * 结构化 FigureSpec → 确定性 SVG 渲染 + 细则第 21 条双向标记核验 + 附图说明
 * 草稿。LLM 只产结构化数据，图形与合规由本模块确定性保证。
 */

export type {
  DocumentKind,
  FigureDirection,
  FigureEdge,
  FigureKind,
  FigureNode,
  FigureNodeShape,
  FigureSpec,
  Jurisdiction,
} from "./types.js";

export {
  checkFigures,
  normalizeRefLabel,
  stripRefMark,
  COMMENT_LABEL_LINE_MAX,
  COMMENT_LABEL_LINES_MAX,
  type FigureCheckFinding,
  type FigureCheckOptions,
  type FigureCheckResult,
  type FigureCheckRuleId,
  type FigureCheckSeverity,
} from "./check.js";
export {
  defaultDirection,
  layoutFigure,
  type FigureLayout,
  type PositionedNode,
  type Point,
  type RoutedEdge,
} from "./layout.js";
export { figureCaption, renderFigureSvg } from "./render-svg.js";
export { FIGURE_FONT_SIZE, isWideChar, measureTextWidth } from "./metrics.js";
export {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  CSS_PX_PER_INCH,
  LEGIBILITY_SHRINK_FACTOR,
  MIN_PRINTED_FONT_MM,
  MM_PER_INCH,
  PAGE_MARGIN_BOTTOM_MM,
  PAGE_MARGIN_LEFT_MM,
  PAGE_MARGIN_RIGHT_MM,
  PAGE_MARGIN_TOP_MM,
  PRINTABLE_HEIGHT_MM,
  PRINTABLE_WIDTH_MM,
  printedFontMm,
  pxToMm,
  uniformFigureZoom,
  type FigurePaperSize,
} from "./page-contract.js";
export {
  buildFigureDot,
  dotEscape,
  dotNodeTitle,
} from "./dot.js";
export {
  FIGURE_RENDERER_ENV,
  GRAPHVIZ_DOT_ENV,
  postProcessGraphvizSvg,
  renderFigureSvgWithGraphviz,
  resolveDotBinary,
} from "./render-graphviz.js";
export { parseFigureSvg, type ParsedFigureSvg } from "./readback.js";
export { splitSpecFaces, type SpecFaces } from "./spec-sections.js";
export {
  FIGURE_SIDECAR_VERSION,
  buildFigureSidecar,
  figureSidecarFileName,
  findFigureSidecar,
  parseFigureSidecar,
  readFigureSidecar,
  type FigureSidecar,
  type FigureSidecarCheck,
  type FigureSidecarFigure,
} from "./sidecar.js";
export { renderFiguresHtml, type FiguresHtmlOptions } from "./html.js";
export { buildFigureBriefDraft, type FigureBriefOptions } from "./brief.js";
