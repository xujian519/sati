/**
 * src/patent/figuregen/cad — 几何级检查（CAD 图特有的确定性判据）。
 *
 * 为什么单列：V 规则吃 FigureSpec 的布局与文字，而 CAD 图的画幅由**投影几何**决定
 * （`render-cad` 按可印区适配缩放），文字面往往为空（标记由代理师后续标注）⇒ 需要
 * 一组针对"投影结果本身"的检查。规则号 `C*` 与 `V*`/`PX*` 分列：它们不是法规条款，
 * 而是"这张投影图能不能清楚交付"的工程判据。
 *
 * 判据（全部确定性、无模型）：
 * - C1 边数：可见边为 0 → fail（投影为空/方向错误）
 * - C2 退化短边：可见边总长 < 阈值 → warn（打印后不可辨的碎边）
 * - C3 适配缩放：为适配 A4 可印区而缩放的比例过低 → warn（线宽同比例变细，建议分幅/改比例）
 * - C4 隐藏线：开启隐藏线 → info（CNIPA 实务以剖视图表达内部结构，虚线不得妨碍标记线）
 *
 * 明确不做（诚实边界）：**最小线间距**检查需要先重建轮廓（相邻边共享端点，逐点距离必然
 * 为 0），属更大的一块工作；当前先以"边数/退化边/缩放"三项覆盖可判定的部分。
 */

import type { FigureCheckSeverity } from "../check.js";
import type { CadEdgeTable } from "./types.js";

export type CadRuleId = "C1" | "C2" | "C3" | "C4";

export type CadFinding = {
  rule: CadRuleId;
  severity: FigureCheckSeverity;
  message: string;
  evidence?: string[];
};

/** C2 阈值：可见边总长下限（毫米）——低于此值的碎边打印后不可辨。 */
export const CAD_MIN_VISIBLE_EDGE_LENGTH_MM = 0.2;
/** C3 阈值：适配缩放低于此值判 warn（线宽与字高同比例缩小）。 */
export const CAD_MIN_FIT_SCALE = 0.5;

/** 边长（折线累加，毫米）。 */
export function polylineLengthMm(points: readonly (readonly [number, number])[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

export type CadCheckInput = {
  table: CadEdgeTable;
  /**
   * 渲染结果（缩放/纸面尺寸）。**缺省时跳过依赖排版的 C2/C3**——C1（边数）不依赖排版，
   * 故调用方可在渲染前先跑一轮把"投影为空"拦在出图之前。
   */
  render?: { scale: number; widthMm: number; heightMm: number };
  hiddenLines: boolean;
};

/** 几何级检查（纯函数）。 */
export function checkCadProjection(input: CadCheckInput): CadFinding[] {
  const findings: CadFinding[] = [];
  const visible = input.table.edges.filter(edge => edge.kind === "visible");

  if (visible.length === 0) {
    findings.push({
      rule: "C1",
      severity: "fail",
      message: `视图 ${input.table.view} 的投影没有可见边（几何不可见或方向错误），不得出图`,
      evidence: [
        `可见边 0，隐藏边 ${input.table.edges.filter(edge => edge.kind === "hidden").length}`,
        `曲线类型：${JSON.stringify(input.table.curveKinds)}`,
      ],
    });
  } else {
    findings.push({
      rule: "C1",
      severity: "info",
      message: `投影边：可见 ${visible.length} 条，隐藏 ${input.table.edges.filter(edge => edge.kind === "hidden").length} 条（视图 ${input.table.view}）`,
    });
  }

  const degenerate = visible
    .map(edge => ({ edge, length: polylineLengthMm(edge.points) }))
    .filter(entry => entry.length < CAD_MIN_VISIBLE_EDGE_LENGTH_MM);
  if (input.render !== undefined && degenerate.length > 0) {
    findings.push({
      rule: "C2",
      severity: "warn",
      message: `有 ${degenerate.length} 条可见边短于 ${CAD_MIN_VISIBLE_EDGE_LENGTH_MM}mm（打印后不可辨），建议降低投影容差或简化几何`,
      evidence: degenerate.slice(0, 5).map(entry => `边长 ${entry.length.toFixed(3)}mm（${entry.edge.curve}）`),
    });
  }

  if (input.render !== undefined && input.render.scale < CAD_MIN_FIT_SCALE) {
    findings.push({
      rule: "C3",
      severity: "warn",
      message:
        `为适配 A4 可印区需缩放到 ${(input.render.scale * 100).toFixed(0)}%（低于 ${CAD_MIN_FIT_SCALE * 100}%）：` +
        "线宽与后续标注字高会同比例变细，建议按视图分幅或改用更合适的视图",
      evidence: [`几何纸面尺寸 ${input.render.widthMm.toFixed(1)}×${input.render.heightMm.toFixed(1)}mm`],
      // 注：evidence 与 C3 同源（渲染结果），故仅在 render 存在时可达
    });
  }

  if (input.hiddenLines) {
    findings.push({
      rule: "C4",
      severity: "info",
      message: "已绘制隐藏线（虚线）：CNIPA 实务以剖视图表达内部结构，请确认虚线不妨碍附图标记线",
    });
  }

  return findings;
}
