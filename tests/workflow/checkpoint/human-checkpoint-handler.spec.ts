import assert from "node:assert/strict";
import test from "node:test";
import {
  HumanCheckpointHandler,
  WorkflowCheckpointError,
  type WorkflowCheckpointPending,
} from "../../../src/workflow/index.js";
import type { WorkflowPlan, WorkflowStep, WorkflowStepOutput } from "../../../src/workflow/protocol/types.js";

/**
 * HumanCheckpointHandler（WorkflowEngine checkpoint 人工通道）组件测试。
 *
 * 引擎在声明 checkpoint 的阶段调用 waitForDecision 挂起，host 经 onPending
 * 发布挂起事件，人工决策经 decide 放行；rejectAll 为会话关闭的清理逃生门。
 */

const STEP: WorkflowStep = {
  id: "review",
  name: "人工审查",
  worker: { name: "w" },
  checkpoint: { title: "请人工确认", allowEdit: true },
  status: "completed",
};

const PLAN: WorkflowPlan = {
  id: "plan-1",
  intent: "测试计划",
  steps: [STEP],
  status: "running",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const OUTPUT: WorkflowStepOutput = { summary: "审查产出摘要" };

test("waitForDecision 挂起并发布 pending，decide(approve) 放行", async () => {
  const pendings: WorkflowCheckpointPending[] = [];
  const handler = new HumanCheckpointHandler({ onPending: p => pendings.push(p) });
  const wait = handler.waitForDecision(STEP, PLAN, OUTPUT);
  // 微任务让 waitForDecision 走到挂起点
  await new Promise(r => setTimeout(r, 0));

  assert.equal(pendings.length, 1, "onPending 应收到挂起快照");
  assert.equal(pendings[0]!.planId, "plan-1");
  assert.equal(pendings[0]!.stepId, "review");
  assert.equal(pendings[0]!.outputPreview, "审查产出摘要");
  assert.equal(handler.pendingCount, 1);
  assert.ok(handler.hasPending(pendings[0]!.id));

  let settled: string | undefined;
  wait.then(() => (settled = "resolved"));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(settled, undefined, "人工决策前不应放行");

  const decided = handler.decide(pendings[0]!.id, { action: "approve", feedback: "确认无误" });
  assert.equal(decided, true);
  assert.deepEqual(await wait, { action: "approve", feedback: "确认无误" });
  assert.equal(handler.pendingCount, 0, "决策后挂起清空");
});

test("decide 幂等：同一 id 二次调用返回 false", async () => {
  const handler = new HumanCheckpointHandler();
  const wait = handler.waitForDecision(STEP, PLAN, OUTPUT);
  await new Promise(r => setTimeout(r, 0));
  const id = 1;
  assert.equal(handler.decide(id, { action: "skip" }), true);
  assert.equal(handler.decide(id, { action: "skip" }), false, "已消费的 id 不应重复放行");
  assert.deepEqual(await wait, { action: "skip" });
});

test("未知 id decide 返回 false（不抛错）", () => {
  const handler = new HumanCheckpointHandler();
  assert.equal(handler.decide(999, { action: "approve" }), false);
});

test("edit / reject 决策透传（含 editedOutput / feedback）", async () => {
  const handler = new HumanCheckpointHandler();
  const editWait = handler.waitForDecision(STEP, PLAN, OUTPUT);
  await new Promise(r => setTimeout(r, 0));
  handler.decide(1, { action: "edit", feedback: "修正表述", editedOutput: { summary: "修正后产出" } });
  assert.deepEqual(await editWait, {
    action: "edit",
    feedback: "修正表述",
    editedOutput: { summary: "修正后产出" },
  });

  const rejectWait = handler.waitForDecision(STEP, PLAN, OUTPUT);
  await new Promise(r => setTimeout(r, 0));
  handler.decide(2, { action: "reject", feedback: "方向不对" });
  assert.deepEqual(await rejectWait, { action: "reject", feedback: "方向不对" });
});

test("rejectAll 批量拒绝全部挂起（会话关闭逃生门）", async () => {
  const handler = new HumanCheckpointHandler();
  const w1 = handler.waitForDecision(STEP, PLAN, OUTPUT);
  const w2 = handler.waitForDecision(STEP, PLAN, OUTPUT);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(handler.pendingCount, 2);

  const cleared = handler.rejectAll("会话已关闭");
  assert.equal(cleared, 2);
  assert.equal(handler.pendingCount, 0);
  assert.deepEqual(await w1, { action: "reject", feedback: "会话已关闭" });
  assert.deepEqual(await w2, { action: "reject", feedback: "会话已关闭" });
  // 空挂起时幂等
  assert.equal(handler.rejectAll(), 0);
});

test("超过 maxPending 上限抛 WorkflowCheckpointError（fail-closed）", async () => {
  const handler = new HumanCheckpointHandler({ maxPending: 2 });
  const w1 = handler.waitForDecision(STEP, PLAN, OUTPUT);
  const w2 = handler.waitForDecision(STEP, PLAN, OUTPUT);
  await new Promise(r => setTimeout(r, 0));
  await assert.rejects(handler.waitForDecision(STEP, PLAN, OUTPUT), WorkflowCheckpointError);
  // 放行全部挂起后恢复容量
  handler.decide(1, { action: "approve" });
  handler.decide(2, { action: "approve" });
  await w1;
  await w2;
  assert.equal(handler.pendingCount, 0);
  const w3 = handler.waitForDecision(STEP, PLAN, OUTPUT);
  await new Promise(r => setTimeout(r, 0));
  handler.decide(3, { action: "approve" });
  await w3;
  assert.equal(handler.pendingCount, 0);
});

test("outputPreview 超长截断至 500 字符", async () => {
  const pendings: WorkflowCheckpointPending[] = [];
  const handler = new HumanCheckpointHandler({ onPending: p => pendings.push(p) });
  const longOutput: WorkflowStepOutput = { summary: "长".repeat(600) };
  const wait = handler.waitForDecision(STEP, PLAN, longOutput);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(pendings[0]!.outputPreview.length, 501, "500 字符 + 省略号");
  assert.ok(pendings[0]!.outputPreview.endsWith("…"));
  handler.decide(pendings[0]!.id, { action: "approve" });
  await wait;
});
