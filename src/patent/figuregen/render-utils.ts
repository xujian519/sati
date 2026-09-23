/**
 * src/patent/figuregen — 渲染器与几何判据的共享小工具（单一实现点）。
 *
 * 为什么单列一个模块：这些函数在本批渲染器里各写过一遍——`escapeXml` 在四个文件里逐字
 * 相同，`fmt` 四份且小数位已漂移成 1/2/3 位，`boxesOverlap`/`boxWithin` 在择位引擎与 CAD
 * C 规则里各写一份。重复的代价不是行数而是**口径漂移**：同一份交付文档里不同渲染器的坐标
 * 精度不同，改精度或给坐标加单位时要改四处，且最容易漏掉子目录里的 CAD 那份；几何谓词各
 * 自演进则会出现"择位引擎说没压盖、C 规则说压盖"（两边各有测试，改一侧不会让另一侧变红）。
 *
 * `fmt` 的小数位是**显式参数**而不是各文件各持一个默认值：差异是有意的（CAD 投影是毫米级
 * 精密图形，需要 3 位；落版页定位 2 位；流程图/曲线图 1 位足够），但必须在调用点看得见。
 */

/** 默认坐标精度（小数位）：内置渲染器（流程图/曲线图）用 1 位。 */
export const FMT_DIGITS = 1;

/** 数值 → SVG 坐标/尺寸文本（固定小数位，去掉浮点噪声；默认 {@link FMT_DIGITS} 位）。 */
export function fmt(value: number, digits: number = FMT_DIGITS): string {
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

/**
 * XML/SVG 文本转义（`&` 必须先行：否则 `&lt;` 会被二次转义成 `&amp;lt;`）。
 *
 * 与 `readback.ts` 的 `unescapeXml` 互逆。**一切文本插值都必须过这里**：交付物是机器
 * 产物，发明名称、节点 label、图号里的 `&` 或 `<` 原样插入即破坏文档结构（提前闭合
 * `<title>`、注入标签）。HTML 侧（`html.ts`）与 SVG 侧同用本函数——两者的转义要求一致。
 */
export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * 几何比较容差。
 *
 * "相切不算压盖""正好贴边不算越界"这类零距离关系必须留容差：同一个几何关系由不同算式
 * （`a.left < b.right` 与 `a.right > b.left`）算出的浮点结果可以相差 1 个 ULP，不留容差
 * 就会让两条等价路径给出相反结论。
 */
export const GEOMETRY_EPS = 1e-9;

/** 轴对齐矩形（纸面毫米；SVG 坐标系，top < bottom）。 */
export type Box = { left: number; top: number; right: number; bottom: number };

/** 两框是否相交（边界相切不算：标号贴着放不算压盖）。 */
export function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.left < b.right - GEOMETRY_EPS &&
    b.left < a.right - GEOMETRY_EPS &&
    a.top < b.bottom - GEOMETRY_EPS &&
    b.top < a.bottom - GEOMETRY_EPS
  );
}

/** a 是否完全落在 b 内（边界含等号：正好贴边不算越界）。 */
export function boxWithin(a: Box, b: Box): boolean {
  return (
    a.left >= b.left - GEOMETRY_EPS &&
    a.right <= b.right + GEOMETRY_EPS &&
    a.top >= b.top - GEOMETRY_EPS &&
    a.bottom <= b.bottom + GEOMETRY_EPS
  );
}
