/**
 * src/patent/figuregen/cad — CAD 结构图 barrel（已有 STEP/3D 源 → 无头投影 → 黑白 SVG）。
 *
 * 数据流：`freecad.ts`（能力探测 + 运行 + 产物解析）→ `anchors.ts`（件号 ↔ 零件归属 +
 * 锚点选取/核对）→ `render-cad.ts`（朝向对齐 + 剖切面投影 + 纸面剖面线 + 附图标记标注 +
 * A4 适配 + SVG）→ `checks.ts`（几何级检查 C1–C16）→ `project.ts`（编排）→
 * `artifacts.ts`（产物落盘）→ `structure-manifest.ts`（视图 / 零件 / 件号对应的可查清单）。
 */

export {
  CAD_VIEWS,
  CAD_ANCHOR_TOLERANCE_MM,
  CAD_EDGE_TABLE_VERSION,
  CAD_PROJECTION_VERSION,
  isCadSectionView,
  isCadView,
  projectModelPoints,
  type CadAnchorCheck,
  type CadEdgeTable,
  type CadPartFact,
  type CadProjectionPayload,
  type CadView,
} from "./types.js";
export {
  CAD_ERROR_MARKER,
  CAD_JSON_BEGIN,
  CAD_JSON_END,
  buildProjectionScript,
  defaultCadRunner,
  describeCadFailure,
  parseProjectionOutput,
  parseProjectionPayload,
  projectStep,
  projectViews,
  resolveFreecadCmd,
  type CadRunner,
  type ProjectStepOptions,
  type ProjectViewsOptions,
} from "./freecad.js";
export { CAD_VIEW_DIRECTIONS, type ProjectionScriptOptions } from "./freecad-script.js";
export {
  CAD_ANCHOR_OUTSET_MM,
  anchorOnPart,
  anchorOutsetMm,
  bindCallouts,
  smallestUnusedRef,
  type CadAnchorBinding,
  type CadCalloutBinding,
  type CadCalloutSource,
} from "./anchors.js";
export {
  CAD_AUTO_ANCHORS_ENV,
  CAD_VIEWS_ENV,
  parseBooleanEnv,
  resolveCadViewPlan,
  type CadViewPlan,
} from "./views.js";
export {
  CAD_CAPTION_FONT_MM,
  CAD_HATCH_ANGLE_BACKWARD_DEG,
  CAD_HATCH_ANGLE_FORWARD_DEG,
  CAD_HATCH_LINE_WIDTH_MM,
  CAD_HATCH_SPACING_MM,
  CAD_HIDDEN_DASH_MM,
  CAD_LEADER_SEGMENT_CAP,
  CAD_LINE_WIDTH_MM,
  CAD_REF_LEADER_MM,
  buildScreenTransform,
  capCadLeaderSegments,
  hatchPolylines,
  orderCutFacesByProximity,
  renderCadSvg,
  type CadHatchOptions,
  type CadRefAnnotation,
} from "./render-cad.js";
export { CAD_REF_FONT_MM, CAD_REF_FONT_STATUTORY_MM, cadRefFontMm } from "./ref-font.js";
export {
  CAD_MIN_FIT_SCALE,
  checkCadProjection,
  findingForLeaderPlacementError,
  polylineLengthMm,
  type CadFinding,
  type CadRuleId,
} from "./checks.js";
export {
  CadProjectionError,
  projectCadViews,
  type CadProjectedView,
  type CadProjectionOutcome,
  type CadProjectRequest,
} from "./project.js";
export {
  CadArtifactError,
  cadViewFileName,
  writeCadArtifacts,
  type CadArtifactsInput,
  type CadArtifactsResult,
} from "./artifacts.js";
export {
  CAD_MANIFEST_VERSION,
  buildCadStructureManifest,
  cadManifestFileName,
  writeCadStructureManifest,
  type CadManifestCallout,
  type CadManifestPart,
  type CadManifestView,
  type CadStructureManifest,
} from "./structure-manifest.js";
