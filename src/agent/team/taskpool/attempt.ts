import { randomUUID } from "node:crypto";
import type { TeamTaskRow } from "../storage/team-db.js";
import { TERMINAL_TASK_STATUSES } from "./task-status.js";

export type TaskAttemptResult = { task: TeamTaskRow; attemptId: string };

/**
 * 开启新 attempt 代际：attempt+1、status=claimed、assignee、清 handoff/reassigning/output。
 * 前置条件（由调用方把关，纯函数不校验）：任务须非终态且非已 claimed（transitionError/attemptsExhausted 兜底）。
 */
export function beginTaskAttempt(
  task: TeamTaskRow,
  assigneeId: string,
  attemptId: string = randomUUID(),
): TaskAttemptResult {
  return {
    attemptId,
    task: {
      ...task,
      status: "claimed",
      assigneeId,
      attempt: task.attempt + 1,
      attemptId,
      handoffId: undefined,
      reassigning: false,
      output: undefined,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** 撤销当前 attempt（转派/重试）：清 attemptId、置 handoffId、回 pending；attempt 计数保留。 */
export function invalidateTaskAttempt(
  task: TeamTaskRow,
  opts: { nextAssigneeId?: string; reassigning?: boolean; handoffId?: string } = {},
): TeamTaskRow {
  const { nextAssigneeId, reassigning = false, handoffId = randomUUID() } = opts;
  return {
    ...task,
    status: "pending",
    assigneeId: nextAssigneeId,
    attemptId: undefined,
    handoffId,
    reassigning,
    output: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/** 迟到写校验：终态任务或 attemptId 不匹配即拒绝（fail-closed）。 */
export function validateAttemptUpdate(task: TeamTaskRow, attemptId: string | undefined): string | undefined {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return "stale-attempt: task is terminal";
  }
  if (task.attemptId === undefined || task.attemptId !== attemptId) {
    return "stale-attempt: attemptId mismatch";
  }
  return undefined;
}

export function attemptsExhausted(task: TeamTaskRow): boolean {
  return task.attempt >= task.maxAttempts;
}
