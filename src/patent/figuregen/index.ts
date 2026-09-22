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
  WORDING_EVIDENCE_MAX,
  type FigureCheckFinding,
  type FigureCheckOptions,
  type FigureCheckResult,
  type FigureCheckRuleId,
  type FigureCheckSeverity,
} from "./check.js";
export {
  WORDING_KIND_SPEC,
  inspectWording,
  scanFigureWording,
  type WordingHit,
  type WordingIssue,
  type WordingIssueKind,
  type WordingKindSpec,
  type WordingRuleId,
  type WordingScope,
  type WordingSeverity,
} from "./wording-rules.js";
export {
  defaultDirection,
  layoutFigure,
  type FigureLayout,
  type PositionedNode,
  type Point,
  type RoutedEdge,
} from "./layout.js";
export {
  DEFAULT_CLEARANCE_MM,
  DEFAULT_COLLINEAR_ANGLE_DEG,
  DEFAULT_COLLINEAR_GAP_MM,
  DEFAULT_LEADER_STEP_MM,
  LEADER_DIRECTIONS_DEG,
  labelBoxOf,
  planLeaderLines,
  type LeaderBox,
  type LeaderLineOptions,
  type LeaderObstacles,
  type LeaderPlacement,
  type LeaderPlan,
  type LeaderPoint,
  type LeaderSegment,
  type LeaderTarget,
} from "./leader-line.js";
export { renderFigureSvg } from "./render-svg.js";
export {
  DEFAULT_OFFICE_PROFILE,
  TARGET_OFFICES,
  figureCaption,
  minCharHeight,
  officeForJurisdiction,
  officeProfile,
  printableArea,
  profileForJurisdiction,
  sheetNumberText,
  shouldRenderCaption,
  type CaptionStyle,
  type OfficeProfile,
  type SheetNumbering,
  type TargetOffice,
} from "./office-profile.js";
export { buildSubmissionPage, type SubmissionPageMetrics, type SubmissionPageOptions } from "./submission-page.js";
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
export { buildFigureDot, dotEscape } from "./dot.js";
export {
  createSubprocessDotRunner,
  FIGURE_RENDERER_ENV,
  GRAPHVIZ_DOT_ENV,
  postProcessGraphvizSvg,
  renderFigureSvgWithGraphviz,
  resolveDotBinary,
  type DotRunner,
} from "./render-graphviz.js";
export { createWasmDotRunner, type VizLoader } from "./render-viz-wasm.js";
export { parseFigureSvg, type ParsedFigureSvg } from "./readback.js";
export {
  DEFAULT_SVG_MAX_BYTES,
  SvgSafetyError,
  assertSafeSvg,
  isSvgSafetyError,
  type SvgSafetyErrorCode,
} from "./svg-safety.js";
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
  type FigureSidecarGeometry,
  type FigureSidecarLayout,
  type FigureSidecarSheet,
} from "./sidecar.js";
export * from "./cad/index.js";
export { renderFiguresHtml, type FiguresHtmlOptions } from "./html.js";
export { buildFigureBriefDraft, type FigureBriefOptions } from "./brief.js";
