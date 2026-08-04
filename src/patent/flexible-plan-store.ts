/**
 * FlexiblePlan 持久化后端（对齐 src/workflow/persistence/WorkflowPlanStore 的
 * save/load/list 三接口；持久化对象为 patent 域的 FlexiblePlanState）。
 *
 * - JsonFileFlexiblePlanStore：每计划一个 JSON 文件（`<dir>/<caseId>.json`），
 *   原子写（先写临时文件再 rename），caseId 安全字符校验防路径注入。
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { atomicWriteJson, assertSafeId } from "./persist-utils.js";
import { fromJSON, toJSON, type FlexiblePlanState } from "./flexible-plan.js";

export interface FlexiblePlanStore {
  savePlan(state: FlexiblePlanState): Promise<void>;
  loadPlan(caseId: string): Promise<FlexiblePlanState | undefined>;
  listCaseIds(): Promise<string[]>;
}

/** JSON 文件存储——每计划一个文件，位于同一目录下。 */
export class JsonFileFlexiblePlanStore implements FlexiblePlanStore {
  constructor(private readonly dir: string) {}

  private fileFor(caseId: string): string {
    // 防御路径注入：caseId 直接拼入文件路径，只允许安全字符集，
    // 禁止路径分隔符与 `..`（否则可写出 dir 目录，或写入隐藏文件）。
    assertSafeId(caseId, "caseId");
    return `${this.dir}/${caseId}.json`;
  }

  async savePlan(state: FlexiblePlanState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(state.caseId);
    await atomicWriteJson(file, toJSON(state));
  }

  async loadPlan(caseId: string): Promise<FlexiblePlanState | undefined> {
    try {
      const raw = await readFile(this.fileFor(caseId), "utf8");
      return fromJSON(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listCaseIds(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter(file => file.endsWith(".json")).map(file => file.slice(0, -".json".length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
