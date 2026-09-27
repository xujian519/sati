/**
 * 标注面契约：一个"可标注的面"要向面无关内核提供什么。
 *
 * 内核（画布、工具条、撤销重做、sidecar、提交）只认这份描述，所以新增介质
 * （PDF 页、Office 渲染面）只需再实现一个来源钩子，不必碰交互与落盘。
 */
import type { AnnotationAnchor, AnnotationTargetKind } from "../../../types/annotationReference";

/** 面的固有尺寸（像素），标注坐标的参照系。 */
export type SurfaceSize = {
  width: number;
  height: number;
};

/**
 * 锚定命中：描述一个客户端坐标点落在面的哪个部件上。
 *
 * 只有能内联成活 DOM 的面提供它——栅格图没有图元层，"落点"这个概念本身不成立。
 */
export type SurfaceHitTest = (
  container: HTMLElement,
  clientX: number,
  clientY: number,
  scaleX: number,
  scaleY: number,
) => AnnotationAnchor | undefined;

/** 已就绪、可标注的面。 */
export type AnnotatableSurface = {
  /** 面种类（进标注文档的 `target.kind`）。 */
  kind: AnnotationTargetKind;
  /** 面固有尺寸。 */
  size: SurfaceSize;
  /**
   * 审阅图的底层标记：SVG 面是 sanitize 过的整棵图，栅格面是一条 `<image>`。
   *
   * 两者都原样嵌进 `composeReviewSvg` 的嵌套 `<svg>`——**不剥根标签**，因为 `xmlns:*`
   * 前缀声明长在根标签上（见 `export.ts`）。
   */
  reviewMarkup: string;
  /** 锚定命中；栅格面缺省。 */
  hitTest?: SurfaceHitTest;
};

/** 面种类 → 引用载荷里的 `locator.surface` 取值。 */
export function referenceSurfaceOf(kind: AnnotationTargetKind): "figure" | "image" {
  return kind === "figure-svg" ? "figure" : "image";
}
