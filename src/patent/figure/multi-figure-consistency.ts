/**
 * 多图一致性检查（P2-1）。
 *
 * 同一案件含多张附图（图1、图2…）时，对多个 FigureAnalysisResult 做跨图
 * 对齐：检测引用标记冲突、图号连续性、图文对齐（权利要求/说明书中引用的
 * 标记是否全部出现在附图中）以及电学网络的跨图一致性。
 */

import { extractClaimRefsDetailed } from "./validator.js";
import type { ElectricalComponent, FigureAnalysisResult } from "./types.js";

export type ComponentConflict = {
  kind: "symbol" | "category" | "name" | "value";
  ref: string;
  /** 出现该 ref 的图号列表。 */
  figureNumbers: number[];
  /** 各图号下的不同取值。 */
  values: { figureNumber: number; value: string }[];
  message: string;
};

export type FigureConsistencyReport = {
  /** 参与分析的附图数量。 */
  figureCount: number;
  /** 全局组件索引：同一 ref 跨图合并后的最佳描述。 */
  globalComponents: Record<string, ElectricalComponent & { figureNumbers: number[] }>;
  /** 全局网络索引：按 net name 合并跨图连接。 */
  globalNets: Record<string, { name: string; connectedRefs: string[]; figureNumbers: number[] }>;
  /**
   * 数字型标记索引（机械/实用新型案：`components[].refNumber`）——电学 components
   * 走 globalComponents，纯数字标记此前**完全未参与**跨图对齐，机械案因此空转。
   */
  numericComponents: Record<string, { name: string; figureNumbers: number[] }>;
  /** 跨图组件冲突。 */
  conflicts: ComponentConflict[];
  /** 图号不连续时报告缺失图号。 */
  missingFigureNumbers: number[];
  /** 权利要求/说明书中引用但在附图中未出现的 ref。 */
  missingRefs: string[];
  /** 单引脚非电源网络（跨图聚合后仍单引脚）。 */
  orphanNets: string[];
  /** 警告列表（人类可读）。 */
  warnings: string[];
  /** 文本摘要。 */
  summary: string;
  /** 是否无冲突且无缺漏。 */
  consistent: boolean;
};

/**
 * 检查多个附图分析结果的一致性。
 *
 * @param figures 附图分析结果（建议按 figureNumber 排序；未排序时内部排序）。
 * @param claimContext 权利要求或说明书文本，用于提取期望出现的附图标记。
 */
export function checkFigureConsistency(
  figures: FigureAnalysisResult[],
  claimContext?: string,
): FigureConsistencyReport {
  const sorted = [...figures].sort((a, b) => a.figureNumber - b.figureNumber);
  const figureNumbers = sorted.map(f => f.figureNumber);

  const globalComponents: Record<string, ElectricalComponent & { figureNumbers: number[] }> = {};
  const globalNets: Record<string, { name: string; connectedRefs: string[]; figureNumbers: number[] }> = {};
  const numericComponents: Record<string, { name: string; figureNumbers: number[] }> = {};
  const conflicts: ComponentConflict[] = [];
  const warnings: string[] = [];

  // 数字型标记跨图归并 + 名称冲突（机械/实用新型案的对齐面：同一标记应始终指同一部件）
  for (const fig of sorted) {
    for (const component of fig.components) {
      const ref = component.refNumber.trim();
      if (!/^\d{1,3}$/u.test(ref)) continue;
      const name = component.name.trim();
      const existing = numericComponents[ref];
      if (!existing) {
        numericComponents[ref] = { name, figureNumbers: [fig.figureNumber] };
        continue;
      }
      existing.figureNumbers = [...new Set([...existing.figureNumbers, fig.figureNumber])].sort((a, b) => a - b);
      if (existing.name !== name && existing.name.length > 0 && name.length > 0) {
        conflicts.push({
          kind: "name",
          ref,
          figureNumbers: existing.figureNumbers,
          values: [
            { figureNumber: existing.figureNumbers[0], value: existing.name },
            { figureNumber: fig.figureNumber, value: name },
          ],
          message: `标记 ${ref} 在图 ${existing.figureNumbers.join(",")} 中名称不一致：${existing.name} / ${name}`,
        });
      }
    }
  }

  // 组件级聚合与冲突检测
  for (const fig of sorted) {
    const electrical = fig.electrical;
    if (!electrical) continue;

    for (const c of electrical.components) {
      const existing = globalComponents[c.ref];
      if (!existing) {
        globalComponents[c.ref] = { ...c, figureNumbers: [fig.figureNumber] };
        continue;
      }

      existing.figureNumbers.push(fig.figureNumber);
      existing.figureNumbers = [...new Set(existing.figureNumbers)].sort((a, b) => a - b);

      const diffs: { kind: ComponentConflict["kind"]; a: string; b: string }[] = [];
      if (existing.symbol !== c.symbol) diffs.push({ kind: "symbol", a: existing.symbol, b: c.symbol });
      if (existing.category !== c.category) diffs.push({ kind: "category", a: existing.category, b: c.category });
      if (existing.name !== c.name) diffs.push({ kind: "name", a: existing.name, b: c.name });
      if (existing.value && c.value && existing.value !== c.value) {
        diffs.push({ kind: "value", a: existing.value, b: c.value });
      }

      for (const d of diffs) {
        conflicts.push({
          kind: d.kind,
          ref: c.ref,
          figureNumbers: existing.figureNumbers,
          values: [
            { figureNumber: existing.figureNumbers[0], value: d.a },
            { figureNumber: fig.figureNumber, value: d.b },
          ],
          message: `标记 ${c.ref} 在图 ${existing.figureNumbers.join(",")} 中 ${d.kind} 不一致：${d.a} / ${d.b}`,
        });
      }

      // 保留更具体的值（有 value 的优先）
      if (!existing.value && c.value) existing.value = c.value;
    }
  }

  // 网络级聚合
  for (const fig of sorted) {
    const electrical = fig.electrical;
    if (!electrical) continue;

    for (const n of electrical.nets) {
      const existing = globalNets[n.name];
      if (!existing) {
        globalNets[n.name] = {
          name: n.name,
          connectedRefs: [...n.connectedRefs],
          figureNumbers: [fig.figureNumber],
        };
      } else {
        existing.figureNumbers.push(fig.figureNumber);
        existing.figureNumbers = [...new Set(existing.figureNumbers)].sort((a, b) => a - b);
        for (const r of n.connectedRefs) {
          if (!existing.connectedRefs.includes(r)) existing.connectedRefs.push(r);
        }
      }
    }
  }

  // 图号连续性
  const missingFigureNumbers: number[] = [];
  if (figureNumbers.length > 0) {
    const max = Math.max(...figureNumbers);
    for (let n = 1; n <= max; n += 1) {
      if (!figureNumbers.includes(n)) missingFigureNumbers.push(n);
    }
  }
  if (missingFigureNumbers.length > 0) {
    warnings.push(`附图编号不连续，缺失图号：${missingFigureNumbers.join(", ")}`);
  }

  // 跨图引用的 ref 冲突：同一 ref 在不同图中 symbol/category 不一致
  if (conflicts.length > 0) {
    warnings.push(...conflicts.map(c => c.message));
  }

  // 权利要求/说明书中的标记是否都在图中出现
  //
  // 两档分别对齐：电学档（R1/C2）对 globalComponents；数字档（壳体(10)/盖板20）对
  // numericComponents。数字档只在"附图中确实存在数字型标记"时启用——否则电学案
  // 的普通数字会被判成"未在附图中识别"（假警告）。
  const extracted = claimContext
    ? extractClaimRefsDetailed(claimContext)
    : { symbols: [] as string[], numerals: [] as number[] };
  const allSymbolRefs = new Set(Object.keys(globalComponents));
  const numericRefs = new Set(Object.keys(numericComponents));
  const missingSymbols = extracted.symbols.filter(r => !allSymbolRefs.has(r));
  const missingNumerals = numericRefs.size === 0 ? [] : extracted.numerals.map(String).filter(r => !numericRefs.has(r));
  const missingRefs = [...missingSymbols, ...missingNumerals];
  if (missingRefs.length > 0) {
    warnings.push(`权利要求/说明书中引用但未在附图中识别：${missingRefs.join(", ")}`);
  }

  // 单引脚非电源网络
  const orphanNets = Object.values(globalNets)
    .filter(n => {
      if (isPowerNet(n.name)) return false;
      // 解析 connectedRefs 为不同元件数量
      const refs = new Set(n.connectedRefs.map(r => r.split(".")[0]).filter(Boolean));
      return refs.size <= 1;
    })
    .map(n => n.name);
  if (orphanNets.length > 0) {
    warnings.push(`跨图聚合后仍仅单元件连接的网络：${orphanNets.join(", ")}`);
  }

  const consistent = conflicts.length === 0 && missingFigureNumbers.length === 0 && missingRefs.length === 0;

  const summary = buildSummary({
    figureCount: sorted.length,
    componentCount: Object.keys(globalComponents).length + Object.keys(numericComponents).length,
    netCount: Object.keys(globalNets).length,
    conflictCount: conflicts.length,
    missingFigureCount: missingFigureNumbers.length,
    missingRefCount: missingRefs.length,
    orphanNetCount: orphanNets.length,
  });

  return {
    figureCount: sorted.length,
    globalComponents,
    globalNets,
    numericComponents,
    conflicts,
    missingFigureNumbers,
    missingRefs,
    orphanNets,
    warnings,
    summary,
    consistent,
  };
}

function isPowerNet(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper === "GND" ||
    upper === "VCC" ||
    upper === "VDD" ||
    upper === "VEE" ||
    upper.startsWith("VCC") ||
    upper.startsWith("VDD")
  );
}

function buildSummary(stats: {
  figureCount: number;
  componentCount: number;
  netCount: number;
  conflictCount: number;
  missingFigureCount: number;
  missingRefCount: number;
  orphanNetCount: number;
}): string {
  const parts: string[] = [];
  parts.push(`附图 ${stats.figureCount} 张，合并识别 ${stats.componentCount} 个元件、${stats.netCount} 个网络。`);
  if (stats.conflictCount > 0) parts.push(`跨图标记冲突 ${stats.conflictCount} 处。`);
  if (stats.missingFigureCount > 0) parts.push(`缺失图号 ${stats.missingFigureCount} 个。`);
  if (stats.missingRefCount > 0) parts.push(`权利要求/说明书中有 ${stats.missingRefCount} 个引用未在附图中识别。`);
  if (stats.orphanNetCount > 0) parts.push(`孤立网络 ${stats.orphanNetCount} 个。`);
  if (stats.conflictCount + stats.missingFigureCount + stats.missingRefCount + stats.orphanNetCount === 0) {
    parts.push("跨图一致性检查通过。");
  }
  return parts.join("");
}
