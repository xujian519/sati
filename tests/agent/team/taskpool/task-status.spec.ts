import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_TASK_STATUSES,
  TASK_TRANSITIONS,
  transitionError,
  unsatisfiedDependencies,
  type TeamTaskStatus,
} from "../../../../src/agent/team/index.js";

test("终态无出边；白名单迁移矩阵完整", () => {
  assert.deepEqual(TASK_TRANSITIONS.pending, ["claimed", "cancelled"]);
  assert.deepEqual(TASK_TRANSITIONS.claimed, ["in_progress", "failed", "cancelled"]);
  assert.deepEqual(TASK_TRANSITIONS.in_progress, ["completed", "failed", "cancelled"]);
  for (const terminal of TERMINAL_TASK_STATUSES) {
    assert.deepEqual(TASK_TRANSITIONS[terminal], []);
  }
});

test("transitionError：非法迁移返回错误，同态/合法返回 undefined", () => {
  assert.equal(transitionError("pending", "completed"), 'task status cannot move from "pending" to "completed"');
  assert.equal(transitionError("claimed", "in_progress"), undefined);
  assert.equal(transitionError("completed", "completed"), undefined);
});

test("unsatisfiedDependencies：只认 completed，缺失 id 也算未满足", () => {
  const tasks = [
    { id: "t1", status: "completed" as TeamTaskStatus },
    { id: "t2", status: "failed" as TeamTaskStatus },
  ];
  assert.deepEqual(unsatisfiedDependencies(tasks as never, ["t1", "t2", "t-missing"]), ["t2", "t-missing"]);
});
