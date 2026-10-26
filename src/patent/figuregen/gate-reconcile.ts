/**
 * figure-gate 的跨层计数：`C*`（投影期预测）与 `RC*`（交付图面实测）对同一缺陷各留一条
 * 证据时只计一次。
 *
 * 两对已知的同源观测：
 * - `C9`（标号越出图幅）与 `RC5`（墨迹越出画布）——越界的是同一批标号，C9 有标记号、
 *   RC5 有实测包围盒，两者互补而非两个缺陷；
 * - `C11`（标号退化为无引线、压在图上）与 `RC1`（文字被线条贯穿）——前者是落位退化，
 *   后者是退化在图面上的可读性后果；同图同时出现时按 fail 保留 RC1，warn 的 C11 不再
 *   重复计。
 *
 * **计数去重不影响阻断**：`rawFail` 仍是各层 fail 的原始和，任一 fail 即阻断；去重只让
 * 报告里的数字不再虚高。原始发现逐条留在报告与 `figure-check.json` 里，合并理由另列。
 */

import type { FigureCheckSeverity } from "./check.js";

/** 参与跨层计数的发现（只需规则号、级别与图号）。 */
export type GateFinding = {
  readonly rule: string;
  readonly severity: FigureCheckSeverity;
  /** 所属图号；结构性 V 规则按图归属，不参与跨层合并。 */
  readonly figure_no: number;
};

/** 门禁计数结果。 */
export type GateCounts = {
  /** 去重后的 fail 数（报告展示用）。 */
  readonly fail: number;
  /** 去重后的 warn 数（报告展示用）。 */
  readonly warn: number;
  /** 去重前的 fail 数（阻断判定用）。 */
  readonly rawFail: number;
  /** 去重前的 warn 数。 */
  readonly rawWarn: number;
  /** 已合并的跨层重复观测（人类可读，随报告留痕）。 */
  readonly merged: readonly string[];
};

export type GateCountInput = {
  readonly structuralFails: number;
  readonly structuralWarns: number;
  readonly rasterFails: number;
  readonly rasterWarns: number;
  readonly render: readonly GateFinding[];
  readonly geometry: readonly GateFinding[];
};

const countBy = (
  findings: readonly GateFinding[],
  figureNo: number,
  rule: string,
  severity: FigureCheckSeverity,
): number =>
  findings.filter(finding => finding.figure_no === figureNo && finding.rule === rule && finding.severity === severity)
    .length;

/**
 * 按图合并 C9↔RC5 与 C11↔RC1 的跨层重复观测。
 *
 * 合并量取两侧条数的较小值：两层都是**按图聚合**的发现（C9/C11 各一条，RC5 一条；RC1
 * 可能有多条文字），取较小值保证不会把额外缺陷吞掉。未配对的发现原样计数。
 * @param input - 各层的发现（结构/栅格只需条数，渲染/几何需要图号与规则号）。
 * @returns 去重前后的 fail/warn 计数与合并说明。
 */
export function reconcileGateCounts(input: GateCountInput): GateCounts {
  const renderFails = input.render.filter(finding => finding.severity === "fail");
  const renderWarns = input.render.filter(finding => finding.severity === "warn");
  const geometryFails = input.geometry.filter(finding => finding.severity === "fail");
  const geometryWarns = input.geometry.filter(finding => finding.severity === "warn");

  const rawFail = input.structuralFails + input.rasterFails + renderFails.length + geometryFails.length;
  const rawWarn = input.structuralWarns + input.rasterWarns + renderWarns.length + geometryWarns.length;
  let fail = rawFail;
  let warn = rawWarn;
  const merged: string[] = [];

  const figures = new Set([...input.render, ...input.geometry].map(finding => finding.figure_no));
  for (const figureNo of [...figures].sort((left, right) => left - right)) {
    // C9 ↔ RC5：同一次「内容越出画布」，两层各报一次。
    const clippedLabels = countBy(input.geometry, figureNo, "C9", "fail");
    const inkOutside = countBy(input.render, figureNo, "RC5", "fail");
    const overlapCanvas = Math.min(clippedLabels, inkOutside);
    if (overlapCanvas > 0) {
      fail -= overlapCanvas;
      merged.push(`图${figureNo}: C9（标号越出图幅）与 RC5（墨迹越出画布）是同一次越界，合并 ${overlapCanvas} 项`);
    }

    // C11 ↔ RC1：标号退化落位与其可读性后果。保留 fail 的 RC1，warn 的 C11 不重复计。
    const degradedLabels = countBy(input.geometry, figureNo, "C11", "warn");
    const crossedTexts = countBy(input.render, figureNo, "RC1", "fail");
    const overlapLegibility = Math.min(degradedLabels, crossedTexts);
    if (overlapLegibility > 0) {
      warn -= overlapLegibility;
      merged.push(`图${figureNo}: C11（标号退化为无引线）与 RC1（文字被线条贯穿）同源，warn 不再重复计、fail 保留`);
    }
  }

  return { fail, warn, rawFail, rawWarn, merged };
}
