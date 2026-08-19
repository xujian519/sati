import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptsExhausted,
  beginTaskAttempt,
  invalidateTaskAttempt,
  validateAttemptUpdate,
  type TeamTaskRow,
} from "../../../../src/agent/team/index.js";

function baseTask(overrides: Partial<TeamTaskRow> = {}): TeamTaskRow {
  return {
    id: "t1",
    teamId: "t1",
    subject: "x",
    description: "",
    status: "pending",
    dependencies: [],
    attempt: 0,
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("beginTaskAttempt：attempt+1、claimed、attemptId、清 handoff/reassigning/output（不可变）", () => {
  const input = baseTask({ status: "pending", handoffId: "h1", reassigning: true, output: "旧" });
  const next = beginTaskAttempt(input, "m1", "cap-a1");
  assert.notEqual(next.task, input); // 不可变
  assert.equal(input.attempt, 0); // 原对象不变
  assert.equal(next.attemptId, "cap-a1");
  assert.equal(next.task.attempt, 1);
  assert.equal(next.task.status, "claimed");
  assert.equal(next.task.assigneeId, "m1");
  assert.equal(next.task.attemptId, "cap-a1");
  assert.equal(next.task.handoffId, undefined);
  assert.equal(next.task.reassigning, false);
  assert.equal(next.task.output, undefined);
});

test("invalidateTaskAttempt：清 attemptId、置 handoffId、回 pending；nextAssigneeId 控制 assignee", () => {
  const claimed = baseTask({ status: "claimed", assigneeId: "m1", attemptId: "a1", attempt: 2 });
  const revoked = invalidateTaskAttempt(claimed, { handoffId: "cap-h1" });
  assert.equal(revoked.status, "pending");
  assert.equal(revoked.attemptId, undefined);
  assert.equal(revoked.handoffId, "cap-h1");
  assert.equal(revoked.assigneeId, undefined);
  assert.equal(revoked.attempt, 2); // attempt 不重置

  const handed = invalidateTaskAttempt(claimed, { handoffId: "cap-h2", nextAssigneeId: "m2", reassigning: true });
  assert.equal(handed.assigneeId, "m2");
  assert.equal(handed.reassigning, true);
  assert.equal(handed.handoffId, "cap-h2");
});

test("validateAttemptUpdate：attemptId 匹配通过，不匹配/缺失拒绝", () => {
  const claimed = baseTask({ status: "in_progress", attemptId: "a1" });
  assert.equal(validateAttemptUpdate(claimed, "a1"), undefined);
  assert.equal(validateAttemptUpdate(claimed, "a2"), "stale-attempt: attemptId mismatch");
  assert.equal(validateAttemptUpdate(baseTask({ status: "completed" }), undefined), "stale-attempt: task is terminal");
});

test("attemptsExhausted：attempt >= maxAttempts 判定", () => {
  assert.equal(attemptsExhausted(baseTask({ attempt: 2 })), false);
  assert.equal(attemptsExhausted(baseTask({ attempt: 3 })), true);
});
