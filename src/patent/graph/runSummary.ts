/**
 * 图 run 摘要落盘：`<runsDir>/graph/<runId>.json`。
 *
 * 图模式此前只在检查点里留状态（`<runsDir>/checkpoints/`），没有「这条 run 用了
 * 哪版规则包、跑到什么程度」的可审计记录。摘要放在**独立子目录**：`runsDir` 本身
 * 是 `JsonFileWorkflowRunStore` 的目录，它的 `listIds()` 会把顶层每个 `.json`
 * 直接 cast 成 `WorkflowRunResult`——图摘要混进去会被当成 manifest run。
 *
 * 写入由调用方放在 `finally`：中断与异常路径同样要留下「用了哪版规则」的记录。
 */

import { join } from "node:path";
import { JsonFileStore } from "../persist-utils.js";
import type { RevisionRecord, RunRulePackInfo } from "../workflow/types.js";
import type { DegradationMark, GraphRunResult } from "./types.js";

/** 图 run 摘要子目录名（与 manifest run JSON 的命名空间分开）。 */
export const GRAPH_RUN_SUMMARY_DIR = "graph";

/** 一条图 run 的审计摘要。 */
export type GraphRunSummary = {
  graph: string;
  runId: string;
  rulePack: RunRulePackInfo;
  completed: boolean;
  steps: number;
  degraded: DegradationMark[];
  revisions?: RevisionRecord[];
  interrupted?: GraphRunResult["interrupted"];
  /** 异常终止信息（正常完成/审批中断路径缺省）；有值时 completed=false。 */
  error?: string;
};

/** 由运行结果（或异常）构造摘要。 */
export function buildGraphRunSummary(input: {
  graph: string;
  runId: string;
  rulePack: RunRulePackInfo;
  result?: GraphRunResult;
  error?: string;
}): GraphRunSummary {
  const result = input.result;
  return {
    graph: input.graph,
    runId: input.runId,
    rulePack: input.rulePack,
    completed: result?.completed ?? false,
    steps: result?.steps ?? 0,
    degraded: result?.degraded ?? [],
    ...(result?.revisions !== undefined ? { revisions: result.revisions } : {}),
    ...(result?.interrupted !== undefined ? { interrupted: result.interrupted } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

/** 原子写入摘要，返回落盘路径（目录不存在时自动创建）。 */
export async function writeGraphRunSummary(runsDir: string, summary: GraphRunSummary): Promise<string> {
  const dir = join(runsDir, GRAPH_RUN_SUMMARY_DIR);
  const store = new JsonFileStore<GraphRunSummary>(dir, raw => JSON.parse(raw) as GraphRunSummary, "runId");
  await store.save(summary.runId, summary);
  return join(dir, `${summary.runId}.json`);
}
