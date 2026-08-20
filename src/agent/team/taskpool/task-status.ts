/**
 * 任务池状态机（移植 dsh patent-teams TASK_TRANSITIONS 语义到 Sati 契约）。
 * pending → claimed → in_progress → completed | failed | cancelled；终态不可变。
 * M3 修订：claimed → completed 直连合法——调度器认领后成员回合内
 * team_update_task(completed) 一步完成（in_progress 保留为可选中间态，供长任务/后续演进）。
 */
import type { TeamTaskRow } from "../storage/team-db.js";

export type TeamTaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "failed" | "cancelled";

export const TASK_TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
  pending: ["claimed", "cancelled"],
  claimed: ["in_progress", "completed", "failed", "cancelled"],
  in_progress: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: readonly TeamTaskStatus[] = ["completed", "failed", "cancelled"];

export function transitionError(current: TeamTaskStatus, next: TeamTaskStatus): string | undefined {
  if (current === next) return undefined;
  if (!TASK_TRANSITIONS[current].includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`;
  }
  return undefined;
}

/** 依赖满足判定：dep 存在且 completed 才算满足；缺失/非完成均返回未满足 id。 */
export function unsatisfiedDependencies(
  tasks: readonly Pick<TeamTaskRow, "id" | "status">[],
  dependencies: string[],
): string[] {
  const byId = new Map(tasks.map(task => [task.id, task.status]));
  return dependencies.filter(id => byId.get(id) !== "completed");
}
