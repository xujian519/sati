import assert from "node:assert/strict";
import test from "node:test";
import {
  PlanTaskSemanticError,
  PlanTaskStateError,
  PlanTaskStateMachine,
  hashStep,
  replanTasks,
  syncPlanToTasks,
} from "../../src/patent/plantask.js";

test("state machine follows the allowed transition chain", () => {
  const sm = new PlanTaskStateMachine();
  assert.equal(sm.state, "planning");
  sm.transition("awaiting_approval");
  sm.transition("executing", { tasks: syncPlanToTasks(["步骤A"]).tasks });
  sm.transition("awaiting_feedback");
  sm.transition("replanning", { feedback: "补充检索范围" });
  sm.transition("awaiting_approval");
  sm.transition("executing", { tasks: syncPlanToTasks(["步骤A", "步骤B"]).tasks });
  sm.transition("finished");
  assert.equal(sm.state, "finished");
});

test("state machine rejects illegal transitions", () => {
  const sm = new PlanTaskStateMachine();
  assert.throws(() => sm.transition("executing"), PlanTaskStateError);
  assert.throws(() => sm.transition("finished"), PlanTaskStateError);
  assert.equal(sm.canTransition("awaiting_approval"), true);
  assert.equal(sm.state, "planning");
});

test("semantic enforcement: executing without tasks is rejected (fail-closed)", () => {
  const sm = new PlanTaskStateMachine("awaiting_approval");
  assert.throws(() => sm.transition("executing"), PlanTaskSemanticError);
  assert.throws(() => sm.transition("executing", {}), PlanTaskSemanticError);
  assert.throws(() => sm.transition("executing", { tasks: [] }), PlanTaskSemanticError);
  // 有任务才放行
  sm.transition("executing", { tasks: syncPlanToTasks(["步骤A"]).tasks });
  assert.equal(sm.state, "executing");
});

test("semantic enforcement: replanning without feedback is rejected (fail-closed)", () => {
  const sm = new PlanTaskStateMachine("awaiting_feedback");
  assert.throws(() => sm.transition("replanning"), PlanTaskSemanticError);
  assert.throws(() => sm.transition("replanning", { feedback: "   " }), PlanTaskSemanticError);
  // 有反馈才放行
  sm.transition("replanning", { feedback: "对比文件 D3 需纳入" });
  assert.equal(sm.state, "replanning");
});

test("syncPlanToTasks builds ordered task list with blockedBy dependencies", () => {
  const steps = ["解析交底书", "检索现有技术", "对比特征", "生成结论"];
  const { tasks, toRun } = syncPlanToTasks(steps);
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].blockedBy, undefined);
  assert.deepEqual(tasks[1].blockedBy, ["task-1"]);
  assert.deepEqual(tasks[3].blockedBy, ["task-3"]);
  assert.equal(toRun.length, 4);
  assert.ok(tasks.every(t => t.status === "pending"));
});

test("hashStep is stable for identical input and differs for different input", () => {
  assert.equal(hashStep("解析交底书"), hashStep("解析交底书"));
  assert.notEqual(hashStep("解析交底书"), hashStep("检索现有技术"));
});

test("replanTasks preserves completed steps by hash and marks new steps to run", () => {
  const initial = syncPlanToTasks(["步骤A", "步骤B"]);
  initial.tasks[0].status = "completed";
  const replanned = replanTasks(initial.tasks, ["步骤A", "步骤B", "步骤C"]);
  assert.equal(replanned.preserved.length, 1);
  assert.equal(replanned.preserved[0], "task-1");
  assert.deepEqual(replanned.toRun, ["task-2", "task-3"]);
  assert.equal(replanned.tasks[0].status, "completed");
  assert.equal(replanned.tasks[1].status, "pending");
  assert.equal(replanned.tasks[2].status, "pending");
});
