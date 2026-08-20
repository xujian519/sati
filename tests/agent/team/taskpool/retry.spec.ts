import assert from "node:assert/strict";
import test from "node:test";
import type { TeamTaskRow } from "../../../../src/agent/team/index.js";
import { retryFailedTask } from "../../../../src/agent/team/index.js";

function task(overrides: Partial<TeamTaskRow>): TeamTaskRow {
  return {
    id: "t1",
    teamId: "team-1",
    subject: "s",
    description: "",
    status: "failed",
    assigneeId: "m1",
    dependencies: [],
    attempt: 1,
    attemptId: "attempt-1",
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("retryFailedTask：failed → pending 重入池，attempt 保留（beginTaskAttempt 再 +1），清 attemptId/assignee/output/handoffId，reassigning 保持 false", () => {
  const out = retryFailedTask(task({ output: "半成品", handoffId: "h-1", reassigning: true }));
  assert.equal(out.status, "pending");
  assert.equal(out.attempt, 1, "attempt 保留（重试计次由 beginTaskAttempt +1）");
  assert.equal(out.attemptId, undefined, "清 attemptId（防 stale-attempt 校验误伤）");
  assert.equal(out.assigneeId, undefined, "回池待认领");
  assert.equal(out.output, undefined);
  assert.equal(out.handoffId, undefined);
  assert.equal(out.reassigning, false, "自动转派不置 reassigning（nextReadyTask 会跳过 reassigning，置位将无人认领）");
});

test("retryFailedTask：不可重试（耗尽/非 failed）返回原任务（幂等安全）", () => {
  const exhausted = task({ attempt: 3, maxAttempts: 3 });
  assert.equal(retryFailedTask(exhausted), exhausted, "耗尽保持 failed 终态");
  const completed = task({ status: "completed" });
  assert.equal(retryFailedTask(completed), completed);
});
