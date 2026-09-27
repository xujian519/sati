/**
 * 标注器的常量与判定。
 *
 * 图片族（SVG 与栅格）统一进标注器：SVG 能内联成活 DOM，因而标注可锚定到具体图元
 * （内置渲染器把节点写成 `id="n-<nodeId>"` + `data-ref`），而"标注 → 改 FigureSpec →
 * 重渲染"这条闭环依赖该锚定；栅格图没有图元层，标注只带坐标与用户写的说明。
 */

/** 画布上可选的工具；`select` 只用于选中与删除，不产生新标注。 */
export const ANNOTATOR_TOOLS = ["select", "arrow", "rect", "ellipse", "pen", "text"] as const;

/** 工具标识。 */
export type AnnotatorTool = (typeof ANNOTATOR_TOOLS)[number];

/** 是否会产生新标注的工具。 */
export function isDrawingTool(tool: AnnotatorTool): boolean {
  return tool !== "select";
}

/** 工具条提供的描边色。 */
export const ANNOTATOR_COLORS = ["#e03131", "#1971c2", "#f08c00", "#2f9e44"] as const;

/** 手绘采样最小间距（面固有像素），低于它的点不入路径。 */
export const PEN_SAMPLE_STEP = 3;

/** 拖拽类标注的最小长度（面固有像素），低于它视为误触。 */
export const MIN_DRAG_DISTANCE = 4;

/** 撤销/重做历史栈上限。 */
export const MARK_HISTORY_LIMIT = 50;

/** 取文件名后缀（小写，不含点）。 */
export function fileExtension(fileNameOrPath: string): string {
  const name = fileNameOrPath.split(/[\\/]/).pop() ?? fileNameOrPath;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 是否走 SVG 面。
 *
 * 只有 SVG 能内联成活 DOM 从而解析图元锚定；其余图片族走栅格面。接管范围由调用方
 * 用 `isImageFile` 决定（扩展名清单的唯一事实源在 `code-editor/utils/binaryFile.ts`）。
 */
export function isSvgPath(fileNameOrPath: string): boolean {
  return fileExtension(fileNameOrPath) === "svg";
}
