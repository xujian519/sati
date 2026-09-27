/**
 * 附图标注器的常量与判定。
 *
 * 一期只把 **SVG** 图接进标注器：只有内联 SVG 能解析出标注落在哪个图元上（内置渲染器
 * 把节点写成 `id="n-<nodeId>"` + `data-ref`），而"标注 → 改 FigureSpec → 重渲染"这条
 * 闭环依赖该锚定。栅格图（PNG/JPEG）仍走原有图片预览（那里已提供矩形区域引用）。
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

/** 手绘采样最小间距（图面像素），低于它的点不入路径。 */
export const PEN_SAMPLE_STEP = 3;

/** 拖拽类标注的最小长度（图面像素），低于它视为误触。 */
export const MIN_DRAG_DISTANCE = 4;

/** 撤销/重做历史栈上限。 */
export const MARK_HISTORY_LIMIT = 50;

/** 取文件名后缀（小写，不含点）。 */
export function figureExtension(fileNameOrPath: string): string {
  const name = fileNameOrPath.split(/[\\/]/).pop() ?? fileNameOrPath;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 该文件是否由标注器接管预览。 */
export function isSvgFigurePath(fileNameOrPath: string): boolean {
  return figureExtension(fileNameOrPath) === "svg";
}
