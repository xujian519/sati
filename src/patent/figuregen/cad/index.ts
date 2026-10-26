/**
 * src/patent/figuregen/cad — CAD 结构图 barrel（阶段一：已有 STEP/3D 源 → 无头投影 → 黑白 SVG）。
 *
 * 数据流：`freecad.ts`（能力探测 + 脚本 + 运行 + 边表解析）→ `render-cad.ts`（朝向对齐 +
 * 剖切面投影 + 纸面剖面线 + 附图标记标注 + A4 适配 + SVG，复用本模块渲染契约）
 * → `checks.ts`（几何级检查）。
 */

export {
  CAD_VIEWS,
  isCadSectionView,
  isCadView,
  projectModelPoints,
  type CadEdgeTable,
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
  projectStep,
  resolveFreecadCmd,
  type CadRunner,
} from "./freecad.js";
export {
  CAD_CAPTION_FONT_MM,
  CAD_HATCH_LINE_WIDTH_MM,
  CAD_HATCH_SPACING_MM,
  CAD_HIDDEN_DASH_MM,
  CAD_LINE_WIDTH_MM,
  CAD_REF_LEADER_MM,
  buildScreenTransform,
  hatchPolylines,
  renderCadSvg,
  type CadRefAnnotation,
} from "./render-cad.js";
export { CAD_REF_FONT_MM, CAD_REF_FONT_STATUTORY_MM, cadRefFontMm } from "./ref-font.js";
export {
  CAD_MIN_FIT_SCALE,
  checkCadProjection,
  polylineLengthMm,
} from "./checks.js";
