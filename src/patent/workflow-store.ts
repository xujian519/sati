/**
 * WorkflowRun 持久化后端（对齐 src/workflow/persistence/WorkflowPlanStore 的设计：
 * 同样的 save/load/list 三接口，持久化对象为 patent 域的 WorkflowRunResult）。
 *
 * - InMemoryWorkflowRunStore：内存 Map，适合测试与单次运行上下文
 * - JsonFileWorkflowRunStore：每 run 一个 JSON 文件（`<dir>/<runId>.json`），
 *   runId 缺省用 manifestId；底层复用 JsonFileStore（与 JsonFileFlexiblePlanStore
 *   同一实现）
 */

import { JsonFileStore } from "./persist-utils.js";
import type { WorkflowRunResult, WorkflowRunStore } from "./workflow.js";

/** 内存存储——适合测试与单次运行上下文。 */
export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  private readonly runs = new Map<string, WorkflowRunResult>();

  async saveRun(result: WorkflowRunResult, runId?: string): Promise<void> {
    this.runs.set(runId ?? result.manifestId, structuredClone(result));
  }

  async loadRun(runId: string): Promise<WorkflowRunResult | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async listRuns(): Promise<string[]> {
    return [...this.runs.keys()];
  }
}

/** JSON 文件存储——每 run 一个文件，位于同一目录下。 */
export class JsonFileWorkflowRunStore implements WorkflowRunStore {
  private readonly store: JsonFileStore<WorkflowRunResult>;

  constructor(dir: string) {
    this.store = new JsonFileStore(dir, raw => JSON.parse(raw) as WorkflowRunResult, "runId");
  }

  async saveRun(result: WorkflowRunResult, runId?: string): Promise<void> {
    await this.store.save(runId ?? result.manifestId, result);
  }

  async loadRun(runId: string): Promise<WorkflowRunResult | undefined> {
    return this.store.load(runId);
  }

  async listRuns(): Promise<string[]> {
    return this.store.listIds();
  }
}
