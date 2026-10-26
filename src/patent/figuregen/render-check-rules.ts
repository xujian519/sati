/**
 * 渲染复核类别 → 规则号/级别的**单点映射**。
 *
 * `RC*` 与 `V*` 结构规则、`PX*` 像素规则分列：这三族吃的是不同的输入——`V*` 吃
 * FigureSpec、`PX*` 吃栅格像素、`RC*` 吃已生成/外部 SVG 的几何。规则号与级别必须在
 * `patent_figure_check`（按需核验）与 `figure-gate`（交付门）之间一致，否则同一张图在
 * 两个入口得到不同结论；故映射只此一份。
 */

import type { FigureCheckSeverity } from "./check.js";
import type { RenderCheckFinding, RenderCheckKind } from "./render-check.js";

/**
 * 级别取「图面读不出来」与「可读性/制图瑕疵」的界线：
 * - `RC1` 文字被线条贯穿、`RC5` 内容越出画布 ⇒ **fail**（前者标号读不出、后者内容根本没渲染）；
 * - `RC2` 净距不足、`RC3` 点划线被实线覆盖、`RC4` 相邻零件剖面线难区分 ⇒ warn（能读但不清）；
 * - `RC0` 未量测 ⇒ info（不是缺陷，是"这份报告没覆盖到哪些结构"的清单）。
 */
export const RENDER_CHECK_RULE: Record<RenderCheckKind, { rule: string; severity: FigureCheckSeverity }> = {
  "text-crossed-by-line": { rule: "RC1", severity: "fail" },
  "ink-outside-canvas": { rule: "RC5", severity: "fail" },
  "text-clearance": { rule: "RC2", severity: "warn" },
  "centerline-covered": { rule: "RC3", severity: "warn" },
  "hatch-orientation-collision": { rule: "RC4", severity: "warn" },
  "not-measured": { rule: "RC0", severity: "info" },
};

/** 一条复核发现 → 带规则号与级别的发现（报告面形状）。 */
export function toRenderCheckFindings(
  findings: readonly RenderCheckFinding[],
): { rule: string; severity: FigureCheckSeverity; message: string }[] {
  return findings.map(finding => ({ ...RENDER_CHECK_RULE[finding.check], message: finding.message }));
}
