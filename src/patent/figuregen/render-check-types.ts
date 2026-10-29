/**
 * render-check 的公共类型与量测内部类型（拆分自 render-check.ts）。
 *
 * 公共类型（`RenderCheckKind`/`InkBounds`/`RenderCheckFinding`/`RenderCheckReport`）经
 * `render-check.ts` 原样再导出，调用方无需改导入路径。
 */

import type { GlyphBox, GlyphTextAnchor } from "./glyph-box.js";

/** 复核发现的问题类别（稳定标识，供调用方分类）。 */
export type RenderCheckKind =
  | "text-crossed-by-line"
  | "text-clearance"
  | "centerline-covered"
  | "hatch-orientation-collision"
  | "ink-outside-canvas"
  | "element-overlap"
  | "font-below-minimum"
  | "not-measured";

/** 图面墨迹的包围盒（毫米，根坐标系）。 */
export type InkBounds = {
  /** 最小 X。 */
  readonly minX: number;
  /** 最小 Y。 */
  readonly minY: number;
  /** 最大 X。 */
  readonly maxX: number;
  /** 最大 Y。 */
  readonly maxY: number;
};

/** 一条复核发现。 */
export type RenderCheckFinding = {
  /** 问题类别。 */
  readonly check: RenderCheckKind;
  /** 模型可见的一句话结论。 */
  readonly message: string;
};

/** 复核报告：量测值 + 发现的问题。 */
export type RenderCheckReport = {
  /** 画布宽（毫米或用户单位）；根元素未声明时为 undefined。 */
  readonly widthMm?: number;
  /** 画布高（毫米或用户单位）；根元素未声明时为 undefined。 */
  readonly heightMm?: number;
  /** 文字元素数。 */
  readonly textCount: number;
  /** 描边图形的线宽分布（毫米 → 元素数，跳过 `stroke: none` 的填充图元），升序。 */
  readonly strokeWidthMm: readonly { readonly widthMm: number; readonly count: number }[];
  /** 线段取向分布（0–180°，点划线/引线/剖面线一并统计），按线段数降序。 */
  readonly orientationDeg: readonly { readonly orientationDeg: number; readonly count: number }[];
  /** 最小字高下限（毫米）：调用方传入时报告回显，未传时缺省（该判据未参与）。 */
  readonly minFontMm?: number;
  /** 发现的问题（无问题为空数组）。 */
  readonly findings: readonly RenderCheckFinding[];
};

/** 二维点（用户单位）。 */
export type Point = readonly [number, number];
/** 线段（用户单位）。 */
export type Segment = { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
/** 顶点表（用户单位）。 */
export type Poly = readonly Point[];
/** 子路径：顶点序列与是否闭合（闭合子路径隐含最后一点回到首点）。 */
export type SubPath = { readonly points: Poly; readonly closed: boolean };
/** 仿射矩阵 `[a b c d e f]`：`x" = a·x + c·y + e`、`y" = b·x + d·y + f`（SVG `matrix()` 同序）。 */
export type Matrix = readonly [number, number, number, number, number, number];
/** 文字占位框经变换后的像：`O`、`O+e1`、`O+e1+e2`、`O+e2`。 */
export type Quad = readonly [Point, Point, Point, Point];

/** 一个描边图形（元素可能含多条子路径）。 */
export type Shape = {
  readonly subpaths: readonly SubPath[];
  /** 线宽（毫米，已按元素的累计缩放换算）。 */
  readonly strokeWidthMm: number;
  /** 是否描边：`stroke: none` 的填充图元不计入线宽分布，但其几何仍参与贯穿与越界判定。 */
  readonly stroked: boolean;
  /** `stroke-dasharray` 的虚线段长（毫米，已按累计缩放换算）；实线元素为 undefined。 */
  readonly dashPatternMm?: readonly number[];
  /** `data-dsh-hatch-group`：同一材料的轮廓共用此值（绘图侧标注）；未标注时为 undefined。 */
  readonly hatchGroup?: number;
  /** `data-dsh-role`：绘图侧标注的线段角色；{@link LEADER_ROLE} 表示引线。 */
  readonly role?: string;
  /** 该元素的不透明填充是否遮挡其下已绘制的图元（白填充）。 */
  readonly occludes: boolean;
  /** 元素在文档序中的位置（0 起）：遮挡只作用于序号更小的图元。 */
  readonly order: number;
};

/** 一个文字元素：内容与经该元素变换后的文字占位框。 */
export type ScannedText = {
  readonly content: string;
  /** 占位框（该元素自身坐标系，用户单位）。 */
  readonly box: GlyphBox;
  /** 该元素的累计变换（占位框经它映射到根坐标系）。 */
  readonly matrix: Matrix;
  /**
   * 该文字是否自带「白色描边挖空」（halo）：`paint-order` 先描边 + 描边为白色。
   * 见 {@link haloedText}——这类文字不参与贯穿与净距判定。
   */
  readonly haloed: boolean;
};

/** 一条落在图面上的线段及其来源。 */
export type DrawnSegment = {
  readonly segment: Segment;
  /** 所属图形的文档序（{@link Shape.order}）。 */
  readonly order: number;
  /** 所属图形被标注为引线（{@link ROLE_ATTRIBUTE}）。 */
  readonly leader: boolean;
};

/** 遮挡面：不透明填充的闭合轮廓及其文档序。 */
export type Occluder = { readonly points: Poly; readonly order: number };

/** 元素按文档序应用后的帧：变换与继承来的样式取值。 */
export type Frame = {
  readonly matrix: Matrix;
  readonly strokeWidthMm: number;
  readonly stroked: boolean;
  /** 该元素的不透明填充被视为遮挡面（白填充）；自祖先继承，`fill: none` 起算为假。 */
  readonly occludes: boolean;
  /** 字号（用户单位；绘制时按帧矩阵换算到毫米）。 */
  readonly fontSizeUser: number;
  /** `text-anchor`（自祖先继承，取值经白名单校验）。 */
  readonly textAnchor: GlyphTextAnchor;
  /** 位于不直接渲染的定义容器内、或 `display: none`：子树整体跳过。 */
  readonly skip: boolean;
};

/** 一张 SVG 的图面事实。 */
export type Scan = {
  readonly widthMm: number | undefined;
  readonly heightMm: number | undefined;
  readonly shapes: readonly Shape[];
  readonly texts: readonly ScannedText[];
  /** 未量测原因（去重，按首次出现顺序）。 */
  readonly unmeasured: readonly string[];
};

/** 图元的几何：认识的图形给出子路径，其余元素无几何。 */
export type ElementGeometry =
  | { readonly kind: "paths"; readonly subpaths: readonly SubPath[] }
  | { readonly kind: "none" };
