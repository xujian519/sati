/**
 * src/patent/figuregen — 专利附图生成模块 barrel。
 *
 * 结构化 FigureSpec → 确定性 SVG 渲染 + 细则第 21 条双向标记核验 + 附图说明
 * 草稿。LLM 只产结构化数据，图形与合规由本模块确定性保证。
 */

export type {
  ChartLineStyle,
  ChartMarker,
  DocumentKind,
  FigureChart,
  FigureKind,
  FigureNode,
  FigureNodeShape,
  FigureSpec,
  Jurisdiction,
} from "./types.js";

export {
  CHART_MARKER_CYCLE,
  chartOutOfRange,
  chartStyleConflicts,
  chartWordingLabels,
  layoutChart,
  renderChartBody,
  resolveChartSeries,
} from "./chart.js";

export {
  checkFigures,
  normalizeRefLabel,
  stripRefMark,
  WORDING_EVIDENCE_MAX,
  type FigureCheckFinding,
  type FigureCheckResult,
  type FigureCheckRuleId,
  type FigureCheckSeverity,
} from "./check.js";
export {
  inspectWording,
  scanFigureWording,
  type WordingIssueKind,
} from "./wording-rules.js";
export { layoutFigure } from "./layout.js";
export {
  DEFAULT_COLLINEAR_ANGLE_DEG,
  LEADER_DIRECTIONS_DEG,
  labelBoxOf,
  planLeaderLines,
  type LeaderBox,
  type LeaderLineOptions,
  type LeaderPlan,
  type LeaderPoint,
  type LeaderSegment,
  type LeaderTarget,
} from "./leader-line.js";
export { renderFigureSvg } from "./render-svg.js";
export {
  TARGET_OFFICES,
  figureCaption,
  minCharHeight,
  officeForJurisdiction,
  officeProfile,
  printableArea,
  profileForJurisdiction,
  sheetNumberText,
  shouldRenderCaption,
  type OfficeProfile,
  type TargetOffice,
} from "./office-profile.js";
export { buildSubmissionPage, type SubmissionPageOptions } from "./submission-page.js";
export { FIGURE_FONT_SIZE, measureTextWidth } from "./metrics.js";
export {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
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
} from "./page-contract.js";
export { buildFigureDot, dotEscape } from "./dot.js";
export {
  FIGURE_RENDERER_ENV,
  postProcessGraphvizSvg,
  renderFigureSvgWithGraphviz,
  resolveDotBinary,
  type DotRunner,
} from "./render-graphviz.js";
export { createWasmDotRunner, type VizLoader } from "./render-viz-wasm.js";
export { parseFigureSvg } from "./readback.js";
export { REF_NUMERAL_PRACTICAL_MAX, isRefNumeral } from "./numeral.js";
export { analyzeImageBuffer, type PixelFinding, type PixelMetrics } from "./pixel-gate.js";
export {
  DEFAULT_SVG_MAX_BYTES,
  SvgSafetyError,
  assertSafeSvg,
  isSvgSafetyError,
} from "./svg-safety.js";
export { splitSpecFaces } from "./spec-sections.js";
export {
  FIGURE_SIDECAR_VERSION,
  buildFigureSidecar,
  figureSidecarFileName,
  findFigureSidecar,
  parseFigureSidecar,
  readFigureSidecar,
  type FigureSidecar,
  type FigureSidecarGeometry,
  type FigureSidecarLayout,
  type FigureSidecarSheet,
} from "./sidecar.js";
export * from "./cad/index.js";
export { renderFiguresHtml } from "./html.js";
export { buildFigureBriefDraft } from "./brief.js";
export {
  writeFigureSidecar,
  writeSubmissionPageArtifact,
} from "./deliverables.js";
export {
  FIGURE_TEXT_TO_PATH_ENV,
  INKSCAPE_CMD_ENV,
  exportSvgTextToPath,
  inkscapeInstallHint,
  isFigureTextToPathEnabled,
  isSvgTarget,
  resolveInkscapeCmd,
  type InkscapeProbe,
} from "./inkscape-renderer.js";
export {
  GLYPH_DESCENT_RATIO,
  GLYPH_ASCENT_RATIO,
  GLYPH_WIDTH_RATIO,
  FULL_WIDTH_RATIO,
  UPPER_WIDTH_RATIO,
  boxEntryAlongRay,
  boxQuad,
  glyphBox,
  inflateQuad,
  quadCrossedBySegment,
  textWidthMm,
} from "./glyph-box.js";
export {
  MM_PER_USER_UNIT,
  measureSvgPaperSize,
  parseLengthMm,
  resolveSvgViewport,
} from "./svg-viewport.js";
export {
  checkFigureRendering,
  measureInkBounds,
  type RenderCheckFinding,
  type RenderCheckKind,
  type RenderCheckReport,
} from "./render-check.js";
export { RENDER_CHECK_RULE, toRenderCheckFindings } from "./render-check-rules.js";
export { reconcileGateCounts, type GateCounts, type GateFinding } from "./gate-reconcile.js";
export { sourceCharHeightMm } from "./source-char-height.js";
