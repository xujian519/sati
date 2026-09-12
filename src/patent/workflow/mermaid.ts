/**
 * patent workflow manifest → Mermaid 可视化。
 *
 * 顺序边实线 `-->`，`retry.rewindTo` 回退边虚线 `-.->`（回退边是受控回退，非依赖边）。
 * 输出为 `flowchart TD`，可直接粘贴渲染；由 `patent_workflow` 工具随 run 产物写
 * `<runsDir>/<runId>.mmd`。
 *
 * 2026-09-11 由 `src/patent/workflow-dag.ts` 迁入（原实现基于 `src/workflow` 的
 * `FlowGraph`，该引擎已删除；本函数自身不依赖 `FlowGraph`，逐字迁移以保持输出不变）。
 */

import type { WorkflowManifest } from "./types.js";

/** 转义 Mermaid 字符串字面量中的反斜杠、引号与换行，避免破坏语法。 */
function escapeName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

/**
 * Mermaid 可视化：顺序边实线 `-->`，retry 回退边虚线 `-.->`。
 * 格式对齐 FlowGraph.formatMermaid（flowchart TD），可直接粘贴渲染。
 */
export function workflowManifestToMermaid(manifest: WorkflowManifest): string {
  const lines = ["flowchart TD"];
  for (const stage of manifest.stages) {
    lines.push(`  ${stage.id}["${escapeName(stage.description)}"]`);
  }
  for (let i = 0; i + 1 < manifest.stages.length; i += 1) {
    lines.push(`  ${manifest.stages[i]!.id} --> ${manifest.stages[i + 1]!.id}`);
  }
  const stageIds = new Set(manifest.stages.map(s => s.id));
  for (const stage of manifest.stages) {
    if (stage.retry?.rewindTo !== undefined && stageIds.has(stage.retry.rewindTo)) {
      lines.push(`  ${stage.id} -.-> ${stage.retry.rewindTo}`);
    }
  }
  return lines.join("\n");
}
