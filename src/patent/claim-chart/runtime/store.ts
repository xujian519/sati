/**
 * claim-chart 持久化（对齐 worker 体系惯例：data/cases/<caseId>/outputs/）：
 * claim-chart-<chartId>.json（结构化，供下游 novelty/inventiveness/draft 消费）
 * + claim-chart-<chartId>.md（交付物：顶部 gap list + 免责声明 + 逐要素映射表）。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, assertSafeId } from "../../persist-utils.js";
import { caseOutputsDir } from "../../paths.js";
import type { ClaimChart } from "../protocol/types.js";

export function chartFileBase(caseId: string, chartId: string): string {
  // 防御路径注入：chartId 直接拼入文件名，仅允许安全字符集（对齐 persist-utils 惯例）。
  assertSafeId(chartId, "chartId");
  return join(caseOutputsDir(caseId), `claim-chart-${chartId}`);
}

export async function saveClaimChart(chart: ClaimChart, caseId: string): Promise<{ jsonPath: string; mdPath: string }> {
  const base = chartFileBase(caseId, chart.chartId);
  mkdirSync(caseOutputsDir(caseId), { recursive: true });
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;
  // 原子写（tmp+rename）：并发/中断不产生半写 JSON（对齐 workflow-store / flexible-plan-store）。
  await atomicWriteJson(jsonPath, JSON.stringify(chart, null, 2));
  await atomicWriteJson(mdPath, renderChartMarkdown(chart));
  return { jsonPath, mdPath };
}

export function loadClaimChart(caseId: string, chartId: string): ClaimChart | null {
  const p = `${chartFileBase(caseId, chartId)}.json`;
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<ClaimChart>;
    // 最小形状守卫：损坏/人工编辑文件不崩溃（chart.ts 的 verified 合并依赖 rows 数组）。
    if (!Array.isArray(parsed.rows) || !Array.isArray(parsed.elements)) return null;
    return parsed as ClaimChart;
  } catch {
    return null;
  }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderChartMarkdown(chart: ClaimChart): string {
  const byId = new Map(chart.elements.map(el => [el.id, el]));
  const lines: string[] = [];
  lines.push(`# 权利要求对照表（Claim Chart）— ${chart.mode}`, "");
  lines.push(`> ${chart.draftNotice}`, "");
  lines.push("## Gap List（优先处理）", "");
  if (chart.gaps.length === 0) {
    lines.push("（无缺口：全部要素均有证据映射）", "");
  } else {
    for (const g of chart.gaps) {
      const el = byId.get(g.elementId);
      lines.push(`- [ ] \`${g.elementId}\` ${el?.text ?? ""} → ${g.targetId}（${g.mapping}）：${g.suggestion}`);
    }
    lines.push("");
  }
  lines.push("## 逐要素映射表", "");
  lines.push("| # | Element | 目标特征/证据 | Evidence (pin-cite) | Mapping | Verified |", "|---|---|---|---|---|---|");
  for (const r of chart.rows) {
    const el = byId.get(r.elementId);
    lines.push(
      `| ${r.elementId} | ${escapeCell(el?.text ?? "")} | ${escapeCell(r.quote)} | ${escapeCell(r.pinCite)} | ${r.mapping} | ${r.verified ? "✓" : "☐"} |`,
    );
  }
  return lines.join("\n");
}
