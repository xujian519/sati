/**
 * FlexiblePlan 持久化后端（对齐 src/workflow/persistence/WorkflowPlanStore 的
 * save/load/list 三接口；持久化对象为 patent 域的 FlexiblePlanState）。
 *
 * - JsonFileFlexiblePlanStore：每计划一个 JSON 文件（`<dir>/<caseId>.json`），
 *   原子写（先写临时文件再 rename），caseId 安全字符校验防路径注入。
 *   底层复用 JsonFileStore（与 JsonFileWorkflowRunStore 同一实现）。
 */

import { fromJSON, type FlexiblePlanState } from "./flexible-plan.js";
import { JsonFileStore } from "./persist-utils.js";

export interface FlexiblePlanStore {
  savePlan(state: FlexiblePlanState): Promise<void>;
  loadPlan(caseId: string): Promise<FlexiblePlanState | undefined>;
  listCaseIds(): Promise<string[]>;
}

/** JSON 文件存储——每计划一个文件，位于同一目录下。 */
export class JsonFileFlexiblePlanStore implements FlexiblePlanStore {
  private readonly store: JsonFileStore<FlexiblePlanState>;

  constructor(dir: string) {
    this.store = new JsonFileStore(dir, fromJSON, "caseId");
  }

  async savePlan(state: FlexiblePlanState): Promise<void> {
    await this.store.save(state.caseId, state);
  }

  async loadPlan(caseId: string): Promise<FlexiblePlanState | undefined> {
    return this.store.load(caseId);
  }

  async listCaseIds(): Promise<string[]> {
    return this.store.listIds();
  }
}
