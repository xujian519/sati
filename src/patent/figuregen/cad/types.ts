/**
 * src/patent/figuregen/cad — CAD 结构图投影的类型契约（阶段一：已有 STEP/3D 源 → 直接投影）。
 *
 * 数据流刻意分两段：**FreeCAD 侧只输出 JSON 边表**（本模块类型），SVG 由 Sati 自己的
 * 渲染契约产出（`render-cad.ts`）⇒ 黑白不变式、`data-ref`、A4 版式、回读**全部复用既有
 * 交付契约**，不新增第二套"谁来画"的实现。
 *
 * 边表 v2 起另带**剖切参数与剖切面轮廓**（剖视图）、以及**投影原点像**（模型坐标 →
 * 图面的仿射映射，附图标记锚点与剖面轮廓都靠它投影）。
 */

/** 支持的视图方向（白名单：非法值 fail-closed，不做"猜一个方向"）。 */
export const CAD_VIEWS = ["front", "back", "left", "right", "top", "bottom", "iso"] as const;

export type CadView = (typeof CAD_VIEWS)[number];

/** 可作为剖切方向的视图（轴对齐：剖切面法向即视线方向，全剖视图）。轴测图不参与剖切。 */
export const CAD_SECTION_VIEWS = ["front", "back", "left", "right", "top", "bottom"] as const;

export type CadSectionView = (typeof CAD_SECTION_VIEWS)[number];

/** 判断视图是否可用于剖切。 */
export function isCadSectionView(value: unknown): value is CadSectionView {
  return typeof value === "string" && (CAD_SECTION_VIEWS as readonly string[]).includes(value);
}

/** 投影边表契约版本（结构变更须升版本并同步解析校验）。 */
export const CAD_EDGE_TABLE_VERSION = 2;

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
 * 模型坐标轴与原点在投影平面上的像（`TechDraw.project` 的坐标系是它自己挑的，**不能**
 * 假定"u 就是 X"）：用四个单位参考体（原点 + 三轴）分别投影得到。渲染侧据此把 (u,v)
 * 对齐到"模型竖直轴在图上竖直、模型右向轴在图上向右"的屏幕坐标（见 `render-cad.ts`）。
 *
 * **为什么需要 origin**：仅有三轴像无法定出仿射映射（各轴像含同一个未知平移 t，
 * 三轴方程不足以解出 t）。有了原点的像，模型坐标 → (u,v) 的映射唯一确定，
 * 剖面轮廓与附图标记锚点才能在 Sati 侧（而非 FreeCAD 侧）投影——投影实现只有一份。
 */
export type CadAxisImages = {
  origin: [number, number];
  x: [number, number];
  y: [number, number];
  z: [number, number];
};

/** 剖切参数（全剖视图）：剖切面垂直于视图方向，位于距模型原点 `offset_mm` 处。 */
export type CadSection = {
  /** 剖切面沿视线方向的带符号位置（模型坐标投影到视线方向上的值，毫米）。 */
  offset_mm: number;
  /**
   * 模型沿视线方向的投影范围（模型坐标，毫米）。用于判定"剖切面是否真的切开了材料"：
   * offset 落在范围之外时剖切退化为整视图（图上有剖面线缺失，属交付缺陷）。
   */
  model_extent_mm: [number, number];
};

/** 剖切面轮廓（**模型坐标**多环折线：第 0 环为外环，其余为孔/缺口内环）。 */
export type CadCutFace = {
  loops: [number, number, number][][];
};

/** 投影边表（FreeCAD → Sati）。 */
export type CadEdgeTable = {
  version: number;
  view: CadView;
  /** 单位（FreeCAD 投影输出即毫米）。 */
  units: "mm";
  /** 投影平面上的模型轴/原点像（对齐与投影用；见 `CadAxisImages`）。 */
  axes: CadAxisImages;
  /** 可见边 + 隐藏边（隐藏边是否绘制由渲染选项决定）。 */
  edges: CadEdge[];
  /** 剖切参数（仅在剖视图请求时出现；缺省表示整视图）。 */
  section?: CadSection;
  /**
   * 剖切面轮廓（模型坐标；仅在剖视图请求时出现）。
   *
   * 刻意给**模型坐标**而非投影坐标：投影由 `projectModelPoints`（本模块）统一完成，
   * FreeCAD 侧不重复实现一套投影——两处实现必然漂移，而朝向对齐只应有一处真相。
   */
  cutFaces?: CadCutFace[];
  /** 被离散化的源曲线类型统计（诊断用）。 */
  curveKinds: Record<string, number>;
};

/** 判断值是否为合法视图。 */
export function isCadView(value: unknown): value is CadView {
  return typeof value === "string" && (CAD_VIEWS as readonly string[]).includes(value);
}

/**
 * 模型坐标 → 投影坐标（仿射；纯函数）。
 *
 * `(u,v) = origin + Σ p_i · (axis_i − origin)`：三轴像各自含同一个平移分量，减去原点像
 * 即得投影矩阵的列。轴像由 0.001mm 参考体投影得到，故列向量含 ≤0.001mm 的方向误差，
 * 对图面标注（毫米级）无观察差异。
 */
export function projectModelPoints(
  axes: CadAxisImages,
  points: readonly (readonly [number, number, number])[],
): [number, number][] {
  const columns: [number, number][] = [
    [axes.x[0] - axes.origin[0], axes.x[1] - axes.origin[1]],
    [axes.y[0] - axes.origin[0], axes.y[1] - axes.origin[1]],
    [axes.z[0] - axes.origin[0], axes.z[1] - axes.origin[1]],
  ];
  return points.map(([x, y, z]) => {
    const coordinates = [x, y, z];
    let u = axes.origin[0];
    let v = axes.origin[1];
    for (let index = 0; index < 3; index += 1) {
      u += coordinates[index]! * columns[index]![0];
      v += coordinates[index]! * columns[index]![1];
    }
    return [u, v] as [number, number];
  });
}
