/**
 * Workflow-plan persistence backends.
 *
 * Adapted from XiaoNuo Agent's `persistence.ts` (InMemory / JSON backends).
 * The engine saves step progress after each step so a crashed run can resume.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { WorkflowPlan } from "../protocol/types.js";

export interface WorkflowPlanStore {
  savePlan(plan: WorkflowPlan): Promise<void>;
  loadPlan(planId: string): Promise<WorkflowPlan | undefined>;
  listPlans(): Promise<string[]>;
}

/** In-memory store — useful for tests and single-run contexts. */
export class InMemoryWorkflowPlanStore implements WorkflowPlanStore {
  private readonly plans = new Map<string, WorkflowPlan>();

  async savePlan(plan: WorkflowPlan): Promise<void> {
    this.plans.set(plan.id, structuredClone(plan));
  }

  async loadPlan(planId: string): Promise<WorkflowPlan | undefined> {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : undefined;
  }

  async listPlans(): Promise<string[]> {
    return [...this.plans.keys()];
  }
}

/** JSON-file store — one file per plan under a directory. */
export class JsonFileWorkflowPlanStore implements WorkflowPlanStore {
  constructor(private readonly dir: string) {}

  private fileFor(planId: string): string {
    return `${this.dir}/${planId}.json`;
  }

  async savePlan(plan: WorkflowPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(plan.id), JSON.stringify(plan, null, 2), "utf8");
  }

  async loadPlan(planId: string): Promise<WorkflowPlan | undefined> {
    try {
      const raw = await readFile(this.fileFor(planId), "utf8");
      const plan = JSON.parse(raw) as WorkflowPlan;
      plan.createdAt = new Date(plan.createdAt);
      plan.updatedAt = new Date(plan.updatedAt);
      return plan;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listPlans(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter(file => file.endsWith(".json")).map(file => file.slice(0, -".json".length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
