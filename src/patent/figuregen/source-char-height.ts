/**
 * 源图字高（毫米）：V7 的字高判据与落版缩放都按**实际渲染器**取值。
 *
 * 生成期与门禁必须调同一个函数：两处各写一份映射时，新分支（如 graphviz-wasm）只会在
 * 一边被漏掉，同一张图在生成期报 V7 warn、在门禁却不报——两边都"有核验"，结论却不同。
 */

import { CAD_REF_FONT_MM } from "./cad/render-cad.js";
import { MM_PER_INCH, pxToMm } from "./page-contract.js";

/** graphviz 字号（pt）：节点 14pt、边标签 12pt，判据取更小的边标签（最小字才有合规意义）。 */
const GRAPHVIZ_CHAR_PT = 12;
/** 内置渲染器的 FIGURE_FONT_SIZE（px）。 */
const BUILTIN_CHAR_PX = 14;

/**
 * @param renderer - sidecar / 生成管线记录的渲染器名（`builtin`、`graphviz`、`graphviz-wasm`、`cad`）。
 * @returns 该渲染器排出的图内最小字高（毫米）。
 */
export function sourceCharHeightMm(renderer: string): number {
  if (renderer === "cad") return CAD_REF_FONT_MM;
  if (renderer === "graphviz" || renderer === "graphviz-wasm") return (GRAPHVIZ_CHAR_PT / 72) * MM_PER_INCH;
  return pxToMm(BUILTIN_CHAR_PX);
}
