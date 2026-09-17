/**
 * src/patent/figuregen/cad — 投影边表 → 黑白 SVG（复用 Sati 自己的渲染契约）。
 *
 * 为什么不直接用 FreeCAD 的 `projectToSVG`：那会引入**第二套交付契约**（颜色/线宽/
 * 版式/data-ref 都要重新归一化，实测其默认样式是 `rgb(0, 0, 0)`，会被本模块的
 * `assertBlackWhite` 判非黑白）。改为：FreeCAD 只给 JSON 边表，SVG 由本模块产出 ⇒
 * 黑白不变式、图号标注、A4 版式、回读自检全部复用既有实现。
 *
 * **朝向对齐**（纯函数，可用录制的边表单测）：实测 `TechDraw.project` 的坐标系由它自己
 * 决定（front 视图里 u 对应 -Z），故 Python 侧另投影三个单位参考体给出模型各轴的像
 * （`axes`）；本模块按视图定义"屏幕右轴/屏幕上轴"，用点积把 (u,v) 映射为屏幕坐标：
 *
 *   x_screen = (u,v)·normalize(image(right))    y_screen = −(u,v)·normalize(image(up))
 *
 * 视图配置（纸面朝向）取"模型竖直轴在图上竖直"的常规约定；**投影法（第一角/第三角）的
 * 纸面配置属交付排版约定**，本模块不声称遵循其中之一（需按最终申请格式复核）。
 */

import { PRINTABLE_HEIGHT_MM, PRINTABLE_WIDTH_MM } from "../page-contract.js";
import type { CadAxisImages, CadEdge, CadEdgeTable, CadView } from "./types.js";

/** 屏幕右轴/上轴（模型坐标，单位向量）。 */
type ScreenAxes = { right: readonly [number, number, number]; up: readonly [number, number, number] };

export const CAD_VIEW_SCREEN_AXES: Record<CadView, ScreenAxes> = {
  front: { right: [1, 0, 0], up: [0, 0, 1] },
  back: { right: [-1, 0, 0], up: [0, 0, 1] },
  left: { right: [0, -1, 0], up: [0, 0, 1] },
  right: { right: [0, 1, 0], up: [0, 0, 1] },
  top: { right: [1, 0, 0], up: [0, 1, 0] },
  bottom: { right: [1, 0, 0], up: [0, -1, 0] },
  // 轴测图：屏幕右/上取模型 +X / +Z 的像（得到常规轴测朝向；其"正确"朝向无唯一约定）
  iso: { right: [1, 0, 0], up: [0, 0, 1] },
};

export type CadRenderOptions = {
  /** 图号（SVG 图号标注"图N"，细则第 21 条式样）。 */
  figureNo: number;
  jurisdiction?: "cn" | "us";
  /** 是否绘制隐藏线（**默认关**：CNIPA 实务以剖视图表达内部结构，虚线易与标记线混淆）。 */
  hiddenLines?: boolean;
  /** 图面外边距（毫米）。 */
  marginMm?: number;
};

export type CadRenderResult = {
  svg: string;
  /** 纸面尺寸（毫米，含外边距）。 */
  widthMm: number;
  heightMm: number;
  /** 缩放系数（把几何适配进可印区；≤ 100% 时不放大）。 */
  scale: number;
  /** 可见/隐藏边数（供几何级检查与报告）。 */
  visibleEdges: number;
  hiddenEdges: number;
};

const DEFAULT_MARGIN_MM = 6;
/** 线宽（毫米）：专利附图线条通常 0.25–0.5mm，取 0.35mm。 */
export const CAD_LINE_WIDTH_MM = 0.35;
/** 隐藏线虚线样式（mm）。 */
export const CAD_HIDDEN_DASH_MM: readonly [number, number] = [1.5, 1];

function dot(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] * b[0] + a[1] * b[1];
}

function normalize(vector: readonly [number, number]): [number, number] | undefined {
  const length = Math.hypot(vector[0], vector[1]);
  if (length < 1e-9) return undefined;
  return [vector[0] / length, vector[1] / length];
}

/**
 * 屏幕坐标映射（纯函数）。轴像退化（某轴的像长度为 0，即该轴正对视线）时返回 undefined
 * ——此时屏幕右/上轴在该视图下不可定义，调用方须 fail-loud 而不是出一张朝向不明的图。
 */
export function buildScreenTransform(
  axes: CadAxisImages,
  view: CadView,
): { x: (u: number, v: number) => number; y: (u: number, v: number) => number } | undefined {
  const spec = CAD_VIEW_SCREEN_AXES[view];
  const imageOf = (axis: readonly [number, number, number]): [number, number] | undefined => {
    const u = axis[0] * axes.x[0] + axis[1] * axes.y[0] + axis[2] * axes.z[0];
    const v = axis[0] * axes.x[1] + axis[1] * axes.y[1] + axis[2] * axes.z[1];
    return normalize([u, v]);
  };
  const rightImage = imageOf(spec.right);
  const upImage = imageOf(spec.up);
  if (rightImage === undefined || upImage === undefined) return undefined;
  return {
    x: (u, v) => dot([u, v], rightImage),
    // SVG 的 y 向下：屏幕坐标 y = −（沿"上轴"的投影分量），故模型上方 = 更小的 y
    y: (u, v) => -dot([u, v], upImage),
  };
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** 投影边表 → 黑白 SVG（A4 可印区适配；确定性：无时钟/随机）。 */
export function renderCadSvg(table: CadEdgeTable, options: CadRenderOptions): CadRenderResult {
  const hiddenLines = options.hiddenLines === true;
  const margin = options.marginMm ?? DEFAULT_MARGIN_MM;
  const drawn: CadEdge[] = table.edges.filter(edge => edge.kind === "visible" || hiddenLines);
  if (drawn.length === 0) {
    throw new TypeError(`视图 ${table.view} 没有可绘制的${hiddenLines ? "" : "可见"}边——请改用其他视图或开启隐藏线`);
  }
  const transform = buildScreenTransform(table.axes, table.view);
  if (transform === undefined) {
    throw new TypeError(
      `视图 ${table.view} 的投影坐标系无法对齐（屏幕右轴或上轴在投影平面退化为一点）——该视图方向与此视图配置不兼容`,
    );
  }

  const projected = drawn.map(edge => ({
    edge,
    points: edge.points.map(([u, v]) => [transform.x(u, v), transform.y(u, v)] as const),
  }));
  const xs = projected.flatMap(entry => entry.points.map(point => point[0]));
  const ys = projected.flatMap(entry => entry.points.map(point => point[1]));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const geometryWidth = Math.max(1e-6, maxX - minX);
  const geometryHeight = Math.max(1e-6, maxY - minY);

  const availableWidth = PRINTABLE_WIDTH_MM - margin * 2;
  const availableHeight = PRINTABLE_HEIGHT_MM - margin * 2;
  const scale = Math.min(1, availableWidth / geometryWidth, availableHeight / geometryHeight);
  const widthMm = geometryWidth * scale + margin * 2;
  const heightMm = geometryHeight * scale + margin * 2;

  const toSvg = (x: number, y: number): [number, number] => [margin + (x - minX) * scale, margin + (y - minY) * scale];

  const paths = projected
    .map(entry => {
      const points = entry.points.map(([x, y]) => {
        const [sx, sy] = toSvg(x, y);
        return `${fmt(sx)},${fmt(sy)}`;
      });
      const style =
        `fill="none" stroke="#000000" stroke-width="${CAD_LINE_WIDTH_MM}"` +
        (entry.edge.kind === "hidden" ? ` stroke-dasharray="${CAD_HIDDEN_DASH_MM[0]} ${CAD_HIDDEN_DASH_MM[1]}"` : "");
      return `<polyline points="${points.join(" ")}" ${style}/>`;
    })
    .join("\n");

  const caption = options.jurisdiction === "us" ? `FIG. ${options.figureNo}` : `图${options.figureNo}`;
  const captionY = heightMm - 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(widthMm)}mm" height="${fmt(heightMm)}mm" ` +
    `viewBox="0 0 ${fmt(widthMm)} ${fmt(heightMm)}" font-family="sans-serif">\n` +
    `<rect x="0" y="0" width="${fmt(widthMm)}" height="${fmt(heightMm)}" fill="#FFFFFF"/>\n` +
    `${paths}\n` +
    `<text x="${fmt(widthMm / 2)}" y="${fmt(captionY)}" font-size="3.5" text-anchor="middle" fill="#000000">` +
    `${escapeXml(caption)}</text>\n` +
    `</svg>\n`;

  return {
    svg,
    widthMm,
    heightMm,
    scale,
    visibleEdges: table.edges.filter(edge => edge.kind === "visible").length,
    hiddenEdges: table.edges.filter(edge => edge.kind === "hidden").length,
  };
}
