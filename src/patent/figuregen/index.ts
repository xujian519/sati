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
  type FigureCheckFinding,
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
export { buildFigureBriefDraft, type FigureBriefOptions } from "./brief.js";
