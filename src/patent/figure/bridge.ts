/**
 * src/patent/figure — 分析轨 ↔ 核验轨桥接（无几何骨架）。
 *
 * 两轨的输入形态不同：分析轨吃**栅格图**、产出 `FigureAnalysisResult`（模型识别的
 * 组件/连接）；核验轨吃**结构化 FigureSpec**、产出确定性规则发现。彼此不通时，
 * 客户提供的扫描图/CAD 导出图只能进分析轨（模型判断），进不了核验轨（确定性规则）。
 *
 * 本模块提供两个方向的**无几何骨架**转换（只取"标记 + 名称"，不含 edges/几何）：
 * - `analysisToFigureSpec`：分析结果 → FigureSpec 骨架，使栅格图进入文字面规则
 *   （调用方须带 `skipLayoutRules`——画幅/字高由原图决定，不由本模块布局决定）；
 * - `figureSpecsToAnalysis`：FigureSpec → 分析结果骨架，使规格化附图进入
 *   `checkFigureConsistency` 的多图对齐（跨图标记/名称冲突、图文对齐）。
 *
 * 骨架**丢弃几何**是有意的：核验轨的布局与画幅规则对本模块未参与排版的图无意义，
 * 保留几何会让调用方误以为那些判定可信。
 */

import { stripRefMark } from "../figuregen/check.js";
import type { FigureNode, FigureSpec } from "../figuregen/types.js";
import type { FigureAnalysisResult, FigureComponent } from "./types.js";

/** 附图标记号取值合法域（纯数字 1..999；无标号部件如 U1 不参与数字档对齐）。 */
const NUMERIC_REF = /^\d{1,3}$/u;

/** 分析结果 → FigureSpec 骨架（组件数 0 时返回 undefined：无标记可核）。 */
export function analysisToFigureSpec(result: FigureAnalysisResult): FigureSpec | undefined {
  const nodes: FigureNode[] = [];
  for (const [index, component] of result.components.entries()) {
    const label = component.name.trim();
    if (label.length === 0) continue;
    const ref = Number.parseInt(component.refNumber.trim(), 10);
    nodes.push({
      id: component.refNumber.trim().length > 0 ? `c-${component.refNumber.trim()}` : `c${index}`,
      label,
      ...(Number.isInteger(ref) && ref > 0 && NUMERIC_REF.test(component.refNumber.trim()) ? { ref } : {}),
    });
  }
  if (nodes.length === 0) return undefined;
  return { figure_no: result.figureNumber, kind: "block", nodes, edges: [] };
}

/** 组件 → 分析轨组件条目（refNumber 与名称；描述/功能不在骨架契约内）。 */
function nodeToComponent(node: FigureNode): FigureComponent {
  return {
    refNumber: node.ref === undefined ? node.id : String(node.ref),
    name: stripRefMark(node.label),
    kind: "unknown",
    description: "",
  };
}

/**
 * FigureSpec → 分析结果骨架（供 `checkFigureConsistency` 复用多图对齐能力）。
 *
 * `confidence` 置 1、`usable` 置 true：骨架来自确定性契约（不是模型识别结果），
 * 不参与"识别可信度"语义；`figureType` 为 unknown（本模块不区分图类型）。
 */
export function figureSpecsToAnalysis(figures: readonly FigureSpec[]): FigureAnalysisResult[] {
  return figures.map(figure => ({
    imagePath: "",
    figureNumber: figure.figure_no,
    figureType: "unknown" as const,
    overallDescription: "",
    components: figure.nodes.map(nodeToComponent),
    connections: [],
    figureDescription: "",
    confidence: 1,
    warnings: [],
    usable: true,
    modelUsed: "",
  }));
}
