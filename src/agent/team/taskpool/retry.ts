/**
 * 失败任务自动转派（M4）：failed 且未耗尽 maxAttempts 的任务重置回 pending 重入
 * 可认领池（attempt 保留，计次由 beginTaskAttempt 再 +1），由调度器锁内
 * 重置后重取快照、同次锁内认领自然派发——成员失败 → onTaskGraphChanged →
 * kickTeam → 锁内重置 + 重取快照 → nextReadyTask 认领给 idle 成员。
 * 防环：attempt >= maxAttempts 即终态（attemptsExhausted），不重置。
 * 与 invalidateTaskAttempt 的关系：语义同为「回 pending」，但自动转派必须
 * reassigning 保持 false（nextReadyTask 跳过 reassigning 任务，置位将无人认领）、
 * 且不生成 handoffId（无人工交接语义）；故独立实现，不复用。
 */
import type { TeamTaskRow } from "../storage/team-db.js";
import { attemptsExhausted } from "./attempt.js";

/** failed 且未耗尽可自动转派的任务 id 列表（纯函数）。 */
export function retryableFailedTasks(tasks: readonly TeamTaskRow[]): string[] {
  return tasks.filter(t => t.status === "failed" && !attemptsExhausted(t)).map(t => t.id);
}

/** 单个失败任务重置为 pending 重入池；不可重试（耗尽/非 failed）原样返回（幂等）。 */
export function retryFailedTask(task: TeamTaskRow): TeamTaskRow {
  if (task.status !== "failed" || attemptsExhausted(task)) return task;
  return {
    ...task,
    status: "pending",
    assigneeId: undefined,
    attemptId: undefined,
    handoffId: undefined,
    reassigning: false,
    output: undefined,
    updatedAt: new Date().toISOString(),
  };
}
