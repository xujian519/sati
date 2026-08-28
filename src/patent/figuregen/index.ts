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
} from "./types.js";

export {
  checkFigures,
  stripRefMark,
  COMMENT_LABEL_LINE_MAX,
  COMMENT_LABEL_LINES_MAX,
  FIGURE_CANVAS_MAX_PX,
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
export { renderFigureSvg } from "./render-svg.js";
export { parseFigureSvg, type ParsedFigureSvg } from "./readback.js";
export { renderFiguresHtml, type FiguresHtmlOptions } from "./html.js";
export { buildFigureBriefDraft, type FigureBriefOptions } from "./brief.js";
