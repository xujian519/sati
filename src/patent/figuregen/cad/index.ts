/**
 * src/patent/figuregen/cad — CAD 结构图 barrel（阶段一：已有 STEP/3D 源 → 无头投影 → 黑白 SVG）。
 *
 * 数据流：`freecad.ts`（能力探测 + 脚本 + 运行 + 边表解析）→ `render-cad.ts`（朝向对齐 +
 * 剖切面投影 + 纸面剖面线 + 附图标记标注 + A4 适配 + SVG，复用本模块渲染契约）
 * → `checks.ts`（几何级检查）。
 */

export {
  CAD_EDGE_TABLE_VERSION,
  CAD_SECTION_VIEWS,
  CAD_VIEWS,
  isCadSectionView,
  isCadView,
  projectModelPoints,
  type CadAxisImages,
  type CadCutFace,
  type CadEdge,
  type CadEdgeTable,
  type CadSection,
  type CadSectionView,
  type CadView,
} from "./types.js";
export {
  CAD_DEFAULT_TIMEOUT_MS,
  CAD_JSON_BEGIN,
  CAD_JSON_END,
  CAD_MAX_EDGES,
  FREECAD_CMD_ENV,
  buildProjectionScript,
  defaultCadRunner,
  parseProjectionOutput,
  projectStep,
  resolveFreecadCmd,
  type CadRunner,
  type FreecadProbe,
  type ProjectStepOptions,
  type ProjectionScriptOptions,
} from "./freecad.js";
export {
  CAD_HATCH_LINE_WIDTH_MM,
  CAD_HATCH_SPACING_MM,
  CAD_HIDDEN_DASH_MM,
  CAD_LINE_WIDTH_MM,
  CAD_MAX_RESERVE_RATIO,
  CAD_REF_FONT_MM,
  CAD_REF_LABEL_GAP_MM,
  CAD_REF_LEADER_MM,
  CAD_REF_RESERVE_PAD_MM,
  CAD_VIEW_SCREEN_AXES,
  buildScreenTransform,
  hatchPolylines,
  renderCadSvg,
  type CadLabelPlacement,
  type CadRefAnnotation,
  type CadRenderOptions,
  type CadRenderResult,
} from "./render-cad.js";
export {
  CAD_MIN_FIT_SCALE,
  CAD_MIN_VISIBLE_EDGE_LENGTH_MM,
  checkCadProjection,
  polylineLengthMm,
  type CadBox,
  type CadCheckInput,
  type CadFinding,
  type CadRuleId,
} from "./checks.js";
