/**
 * WorkflowRun 持久化后端（对齐 src/workflow/persistence/WorkflowPlanStore 的设计：
 * 同样的 save/load/list 三接口，持久化对象为 patent 域的 WorkflowRunResult）。
 *
 * - InMemoryWorkflowRunStore：内存 Map，适合测试与单次运行上下文
 * - JsonFileWorkflowRunStore：每 run 一个 JSON 文件（`<dir>/<runId>.json`），
 *   runId 缺省用 manifestId；与 JsonFileWorkflowPlanStore 同一模式
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { atomicWriteJson, assertSafeId } from "./persist-utils.js";
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
  constructor(private readonly dir: string) {}

  private fileFor(runId: string): string {
    // 防御路径注入：runId 直接拼入文件路径，只允许安全字符集，
    // 禁止路径分隔符与 `..`（否则可写出 dir 目录，或写入隐藏文件）。
    assertSafeId(runId, "runId");
    return `${this.dir}/${runId}.json`;
  }

  async saveRun(result: WorkflowRunResult, runId?: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(runId ?? result.manifestId);
    // 原子写：先写同目录临时文件再 rename，避免中断/并发产生半写 JSON。
    await atomicWriteJson(file, JSON.stringify(result, null, 2));
  }

  async loadRun(runId: string): Promise<WorkflowRunResult | undefined> {
    try {
      const raw = await readFile(this.fileFor(runId), "utf8");
      return JSON.parse(raw) as WorkflowRunResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listRuns(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter(file => file.endsWith(".json")).map(file => file.slice(0, -".json".length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
