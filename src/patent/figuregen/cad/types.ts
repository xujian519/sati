/**
 * src/patent/figuregen/cad — CAD 结构图投影的类型契约（阶段一：已有 STEP/3D 源 → 直接投影）。
 *
 * 数据流刻意分两段：**FreeCAD 侧只输出 JSON 边表**（本模块类型），SVG 由 Sati 自己的
 * 渲染契约产出（`render-cad.ts`）⇒ 黑白不变式、`data-ref`（本阶段无标记）、A4 版式、
 * 回读**全部复用既有交付契约**，不新增第二套"谁来画"的实现。
 */

/** 支持的视图方向（白名单：非法值 fail-closed，不做"猜一个方向"）。 */
export const CAD_VIEWS = ["front", "back", "left", "right", "top", "bottom", "iso"] as const;

export type CadView = (typeof CAD_VIEWS)[number];

/** 投影边表契约版本（结构变更须升版本并同步解析校验）。 */
export const CAD_EDGE_TABLE_VERSION = 1;

/** 单条投影边。 */
export type CadEdge = {
  kind: "visible" | "hidden";
  /**
   * 源曲线类型（`Line`/`BSplineCurve`/…，FreeCAD 的类名）。
   * 仅供诊断：点列已按容差离散化，渲染按 `points` 走。
   */
  curve: string;
  /** 是否闭合轮廓（用于"存在闭合轮廓"的几何检查）。 */
  closed: boolean;
  /** 折线点列（纸面毫米，已归一化到第一象限）。 */
  points: [number, number][];
};

/**
 * 模型坐标轴在投影平面上的像（`TechDraw.project` 的坐标系是它自己挑的，**不能**假定
 * "u 就是 X"）：用三个单位参考体分别投影得到。渲染侧据此把 (u,v) 对齐到"模型竖直轴在
 * 图上竖直、模型右向轴在图上向右"的屏幕坐标（见 `render-cad.ts`）。
 */
export type CadAxisImages = {
  x: [number, number];
  y: [number, number];
  z: [number, number];
};

/** 投影边表（FreeCAD → Sati）。 */
export type CadEdgeTable = {
  version: number;
  view: CadView;
  /** 单位（FreeCAD 投影输出即毫米）。 */
  units: "mm";
  /** 投影平面上的模型轴像（对齐用；见 `CadAxisImages`）。 */
  axes: CadAxisImages;
  /** 可见边 + 隐藏边（隐藏边是否绘制由渲染选项决定）。 */
  edges: CadEdge[];
  /** 被离散化的源曲线类型统计（诊断用）。 */
  curveKinds: Record<string, number>;
};

/** 判断值是否为合法视图。 */
export function isCadView(value: unknown): value is CadView {
  return typeof value === "string" && (CAD_VIEWS as readonly string[]).includes(value);
}
