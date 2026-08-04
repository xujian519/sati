import assert from "node:assert/strict";
import test from "node:test";
import {
  FlexiblePlanError,
  abandon,
  addStage,
  attachArticleJudgment,
  complete,
  confirmStage,
  createFlexiblePlan,
  fromJSON,
  removeStage,
  reorderStages,
  rollbackStage,
  toJSON,
  toManifest,
  type FlexibleStage,
} from "../../src/patent/flexible-plan.js";
import { FactBlackboard } from "../../src/patent/reasoning/fact-blackboard.js";

/** 构造最小合法阶段（减少样板）。 */
function stage(id: string, overrides: Partial<FlexibleStage> = {}): FlexibleStage {
  return {
    id,
    name: id,
    goal: `目标 ${id}`,
    strategy: "chain",
    status: "pending",
    artifacts: [],
    constraintIds: [],
    articleJudgments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createFlexiblePlan
// ---------------------------------------------------------------------------

test("createFlexiblePlan 创建空计划", () => {
  const plan = createFlexiblePlan("case-1", "invalidation");
  assert.equal(plan.caseId, "case-1");
  assert.equal(plan.caseType, "invalidation");
  assert.equal(plan.status, "active");
  assert.deepEqual(plan.stages, []);
  assert.equal(plan.currentStageId, undefined);
});

test("createFlexiblePlan 带初始阶段时 currentStageId 指向首个且全部 pending", () => {
  const plan = createFlexiblePlan("case-1", "invalidation", {
    stages: [stage("s1"), stage("s2")],
  });
  assert.equal(plan.currentStageId, "s1");
  assert.equal(plan.stages.length, 2);
  assert.ok(plan.stages.every(s => s.status === "pending"));
});

test("createFlexiblePlan 空 caseId/caseType 抛错", () => {
  assert.throws(() => createFlexiblePlan("", "invalidation"), FlexiblePlanError);
  assert.throws(() => createFlexiblePlan("case-1", ""), FlexiblePlanError);
});

test("createFlexiblePlan 重复阶段 id / 空 id 抛错", () => {
  assert.throws(
    () => createFlexiblePlan("c", "invalidation", { stages: [stage("s1"), stage("s1")] }),
    FlexiblePlanError,
  );
  assert.throws(
    () => createFlexiblePlan("c", "invalidation", { stages: [{ ...stage("s1"), id: " " }] }),
    FlexiblePlanError,
  );
});

// ---------------------------------------------------------------------------
// addStage / removeStage / reorderStages
// ---------------------------------------------------------------------------

test("addStage 追加阶段并仅在无当前阶段时设置 currentStageId", () => {
  const plan = createFlexiblePlan("c", "invalidation");
  const next = addStage(plan, stage("s1"));
  assert.equal(next.stages.length, 1);
  assert.equal(next.currentStageId, "s1");
  const next2 = addStage(next, stage("s2"));
  assert.equal(next2.stages.length, 2);
  assert.equal(next2.currentStageId, "s1"); // 已有当前阶段不覆盖
  assert.equal(next2.stages[1].status, "pending");
});

test("addStage 重复 id / 空 id / 非 active 抛错", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1")] });
  assert.throws(() => addStage(plan, stage("s1")), FlexiblePlanError);
  assert.throws(() => addStage(plan, { ...stage("s2"), id: " " }), FlexiblePlanError);
  const done = complete(plan);
  assert.throws(() => addStage(done, stage("s2")), FlexiblePlanError);
});

test("removeStage 删除阶段且 currentStageId 回落到下一待执行阶段", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1"), stage("s2")] });
  const next = removeStage(plan, "s1");
  assert.equal(next.stages.length, 1);
  assert.equal(next.stages[0].id, "s2");
  assert.equal(next.currentStageId, "s2");
});

test("removeStage 未知阶段 / 非 active 抛错", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1")] });
  assert.throws(() => removeStage(plan, "nope"), FlexiblePlanError);
  const done = complete(plan);
  assert.throws(() => removeStage(done, "s1"), FlexiblePlanError);
});

test("reorderStages 重排阶段", () => {
  const plan = createFlexiblePlan("c", "invalidation", {
    stages: [stage("s1"), stage("s2"), stage("s3")],
  });
  const next = reorderStages(plan, ["s3", "s1", "s2"]);
  assert.deepEqual(
    next.stages.map(s => s.id),
    ["s3", "s1", "s2"],
  );
});

test("reorderStages 非法顺序抛错（缺少 / 重复 / 未知）", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1"), stage("s2")] });
  assert.throws(() => reorderStages(plan, ["s1"]), FlexiblePlanError);
  assert.throws(() => reorderStages(plan, ["s1", "s1"]), FlexiblePlanError);
  assert.throws(() => reorderStages(plan, ["s1", "nope"]), FlexiblePlanError);
});

// ---------------------------------------------------------------------------
// confirmStage / rollbackStage
// ---------------------------------------------------------------------------

test("confirmStage 确认后推进到下一未确认阶段", () => {
  const plan = createFlexiblePlan("c", "invalidation", {
    stages: [stage("s1"), stage("s2"), stage("s3")],
  });
  const s1 = confirmStage(plan, "s1");
  assert.equal(s1.stages[0].status, "confirmed");
  assert.equal(s1.currentStageId, "s2");
  const s2 = confirmStage(s1, "s2");
  assert.equal(s2.stages[1].status, "confirmed");
  assert.equal(s2.currentStageId, "s3");
});

test("confirmStage 全部确认后 currentStageId 为空", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1"), stage("s2")] });
  const all = confirmStage(confirmStage(plan, "s1"), "s2");
  assert.equal(all.currentStageId, undefined);
  assert.ok(all.stages.every(s => s.status === "confirmed"));
});

test("confirmStage 未知阶段 / 非 active 抛错", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1")] });
  assert.throws(() => confirmStage(plan, "nope"), FlexiblePlanError);
  const done = complete(plan);
  assert.throws(() => confirmStage(done, "s1"), FlexiblePlanError);
});

test("rollbackStage 目标及其后 confirmed 置 rolled_back，之前保留", () => {
  const plan = createFlexiblePlan("c", "invalidation", {
    stages: [stage("s1"), stage("s2"), stage("s3")],
  });
  const confirmed = confirmStage(confirmStage(confirmStage(plan, "s1"), "s2"), "s3");
  assert.ok(confirmed.stages.every(s => s.status === "confirmed"));

  const rolled = rollbackStage(confirmed, "s2");
  assert.equal(rolled.stages[0].status, "confirmed"); // s1 保留
  assert.equal(rolled.stages[1].status, "rolled_back"); // s2 重做
  assert.equal(rolled.stages[2].status, "rolled_back"); // s3 作废
  assert.equal(rolled.currentStageId, "s2");
});

test("rollbackStage 回退到 pending 阶段时其后的 confirmed 作废、pending 保持", () => {
  const plan = createFlexiblePlan("c", "invalidation", {
    stages: [stage("s1"), stage("s2"), stage("s3")],
  });
  const confirmed = confirmStage(plan, "s1");
  const premature = confirmStage(confirmed, "s3"); // 跳过 s2 提前确认（agent 失误场景）
  assert.equal(premature.stages[1].status, "pending");

  const rolled = rollbackStage(premature, "s2");
  assert.equal(rolled.stages[0].status, "confirmed"); // s1 保留
  assert.equal(rolled.stages[1].status, "pending"); // s2 未执行过，保持 pending
  assert.equal(rolled.stages[2].status, "rolled_back"); // s3 作废
  assert.equal(rolled.currentStageId, "s2");
});

test("rollbackStage 未知阶段 / 非 active 抛错", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1")] });
  assert.throws(() => rollbackStage(plan, "nope"), FlexiblePlanError);
  const done = complete(plan);
  assert.throws(() => rollbackStage(done, "s1"), FlexiblePlanError);
});

// ---------------------------------------------------------------------------
// attachArticleJudgment
// ---------------------------------------------------------------------------

test("attachArticleJudgment 写入黑板并记录阶段引用", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1")] });
  const bb = new FactBlackboard({ caseId: "c", caseType: "invalidation" });
  const judgment = {
    articleId: "A22.2",
    satisfied: true,
    reasoning: "对比文件未公开区别特征，具备新颖性",
    confidence: 0.9,
    judgedAt: "2026-01-01T00:00:00.000Z",
  };
  const next = attachArticleJudgment(plan, "s1", judgment, bb);
  assert.deepEqual(next.stages[0].articleJudgments, ["A22.2"]);
  assert.equal(bb.getArticleJudgment("A22.2")?.articleId, "A22.2");
  assert.equal(bb.getArticleJudgment("A22.2")?.satisfied, true);
});

test("attachArticleJudgment 重复引用去重 + locked 黑板抛错 + 未知阶段抛错", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1")] });
  const bb = new FactBlackboard({ caseId: "c", caseType: "invalidation" });
  const judgment = {
    articleId: "A22.2",
    satisfied: true,
    reasoning: "r",
    confidence: 0.9,
    judgedAt: "2026-01-01T00:00:00.000Z",
  };
  const once = attachArticleJudgment(plan, "s1", judgment, bb);
  const twice = attachArticleJudgment(once, "s1", judgment, bb);
  assert.deepEqual(twice.stages[0].articleJudgments, ["A22.2"]);

  const lockedBb = new FactBlackboard({ caseId: "c", caseType: "invalidation" });
  lockedBb.lock();
  assert.throws(() => attachArticleJudgment(plan, "s1", judgment, lockedBb), /locked/i);
  assert.throws(() => attachArticleJudgment(plan, "nope", judgment, bb), FlexiblePlanError);
});

// ---------------------------------------------------------------------------
// toManifest
// ---------------------------------------------------------------------------

test("toManifest 过滤 rolled_back，goal → description", () => {
  const plan = createFlexiblePlan("c", "invalidation", {
    stages: [stage("s1", { atom: "extract", params: { output_key: "x" } }), stage("s2")],
  });
  const confirmed = confirmStage(plan, "s1");
  const rolled = rollbackStage(confirmed, "s1"); // s1 rolled_back
  const manifest = toManifest(rolled);
  assert.equal(manifest.id, "flexible_c");
  assert.equal(manifest.caseType, "invalidation");
  assert.deepEqual(
    manifest.stages.map(s => s.id),
    ["s2"],
  ); // s1 被过滤
  assert.equal(manifest.stages[0].description, "目标 s2");
});

test("toManifest 透传 strategy/atom/params", () => {
  const plan = createFlexiblePlan("c", "invalidation", {
    stages: [{ ...stage("s1"), strategy: "sub_agent", atom: "reasoning", params: { mode: "novelty" } }],
  });
  const manifest = toManifest(plan);
  assert.equal(manifest.stages[0].strategy, "sub_agent");
  assert.equal(manifest.stages[0].atom, "reasoning");
  assert.deepEqual(manifest.stages[0].params, { mode: "novelty" });
});

// ---------------------------------------------------------------------------
// toJSON / fromJSON
// ---------------------------------------------------------------------------

test("toJSON/fromJSON 往返保持状态", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1"), stage("s2")] });
  const confirmed = confirmStage(plan, "s1");
  const restored = fromJSON(toJSON(confirmed));
  assert.deepEqual(restored, confirmed);
});

test("fromJSON 非法快照抛错", () => {
  assert.throws(() => fromJSON("{}"), FlexiblePlanError);
  assert.throws(() => fromJSON(JSON.stringify({ caseId: "c", caseType: "x" })), FlexiblePlanError);
  assert.throws(
    () => fromJSON(JSON.stringify({ caseId: "c", caseType: "x", stages: [], status: "weird" })),
    FlexiblePlanError,
  );
  assert.throws(() => fromJSON("{not-json"), SyntaxError);
});

// ---------------------------------------------------------------------------
// complete / abandon / 终态守卫
// ---------------------------------------------------------------------------

test("complete 将全部 pending 置 confirmed 并结束计划", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1"), stage("s2")] });
  const done = complete(plan);
  assert.equal(done.status, "completed");
  assert.ok(done.stages.every(s => s.status === "confirmed"));
  assert.equal(done.currentStageId, undefined);
});

test("abandon 将 pending 置 rolled_back、confirmed 保留审计、记录原因", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1"), stage("s2")] });
  const confirmed = confirmStage(plan, "s1");
  const ab = abandon(confirmed, "用户取消");
  assert.equal(ab.status, "abandoned");
  assert.equal(ab.abandonReason, "用户取消");
  assert.equal(ab.stages[0].status, "confirmed");
  assert.equal(ab.stages[1].status, "rolled_back");
});

test("completed/abandoned 计划拒绝全部变更操作", () => {
  const plan = createFlexiblePlan("c", "invalidation", { stages: [stage("s1")] });
  const done = complete(plan);
  assert.throws(() => addStage(done, stage("s2")), FlexiblePlanError);
  assert.throws(() => removeStage(done, "s1"), FlexiblePlanError);
  assert.throws(() => reorderStages(done, ["s1"]), FlexiblePlanError);
  assert.throws(() => confirmStage(done, "s1"), FlexiblePlanError);
  assert.throws(() => rollbackStage(done, "s1"), FlexiblePlanError);
  assert.throws(() => complete(done), FlexiblePlanError);

  const ab = abandon(plan, "r");
  assert.throws(() => addStage(ab, stage("s2")), FlexiblePlanError);
  assert.throws(() => complete(ab), FlexiblePlanError);
  assert.throws(() => abandon(ab, "again"), FlexiblePlanError);
});
