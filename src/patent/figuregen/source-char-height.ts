/**
 * 源图字高（毫米）：V7 的字高判据与落版缩放都按**实际渲染器**取值。
 *
 * 生成期与门禁必须调同一个函数：两处各写一份映射时，新分支（如 graphviz-wasm）只会在
 * 一边被漏掉，同一张图在生成期报 V7 warn、在门禁却不报——两边都"有核验"，结论却不同。
 */

import { cadRefFontMm } from "./cad/ref-font.js";
import { EDGE_FONT_RATIO, figureFontMm } from "./metrics.js";
import { MM_PER_INCH, pxToMm } from "./page-contract.js";
import type { Jurisdiction } from "./types.js";

/** graphviz 字号（pt）：节点 14pt、边标签 12pt，判据取更小的边标签（最小字才有合规意义）。 */
const GRAPHVIZ_CHAR_PT = 12;
/** 内置渲染器的 FIGURE_FONT_SIZE（px）。 */
const BUILTIN_CHAR_PX = 14;

/**
 * @param renderer - sidecar / 生成管线记录的渲染器名（`builtin`、`graphviz`、`graphviz-wasm`、`cad`）。
 * @param jurisdiction - 辖区（CAD 标号字号按法定下限取值；缺省 CNIPA）。
 * @param env - 环境变量源（注入可测性）；缺省 `process.env`。
 * @returns 该渲染器排出的图内最小字高（毫米）。
 */
export function sourceCharHeightMm(
  renderer: string,
  jurisdiction?: Jurisdiction,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // 部署级字号优先：它给的是**主字号**，而本函数回答的是"图内最小字"。内置与 Graphviz
  // 的边标签是主字号的 12/14，故按同一比例折算（否则 V7 会把边标签字高等同于节点字高）。
  // CAD 通路没有主/次字号之分，标号本身就是最小字，直接取 env 值。
  const override = figureFontMm(env);
  if (override !== undefined) {
    return renderer === "cad" ? override : override * EDGE_FONT_RATIO;
  }
  if (renderer === "cad") return cadRefFontMm(jurisdiction, env);
  if (renderer === "graphviz" || renderer === "graphviz-wasm") return (GRAPHVIZ_CHAR_PT / 72) * MM_PER_INCH;
  return pxToMm(BUILTIN_CHAR_PX);
}
