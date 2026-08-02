import assert from "node:assert/strict";
import test from "node:test";
import {
  patentDisclosureManifest,
  runWorkflow,
  validateWorkflowManifest,
  type WorkflowManifest,
  type WorkflowStage,
} from "../../src/patent/index.js";

// ---------------------------------------------------------------------------
// retry 校验
// ---------------------------------------------------------------------------

test("validate：retry.whenOutputMatches 空/非法正则被拦截", () => {
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "t",
        name: "t",
        caseType: "t",
        stages: [{ id: "a", strategy: "chain", description: "a", retry: { whenOutputMatches: "  " } }],
      }),
    /whenOutputMatches 不能为空/,
  );
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "t",
        name: "t",
        caseType: "t",
        stages: [{ id: "a", strategy: "chain", description: "a", retry: { whenOutputMatches: "(" } }],
      }),
    /非法正则/,
  );
});

test("validate：retry.rewindTo 指向不存在/自身阶段被拦截", () => {
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "t",
        name: "t",
        caseType: "t",
        stages: [
          { id: "a", strategy: "chain", description: "a" },
          { id: "b", strategy: "chain", description: "b", retry: { whenOutputMatches: "x", rewindTo: "nope" } },
        ],
      }),
    /rewindTo 指向不存在的阶段/,
  );
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "t",
        name: "t",
        caseType: "t",
        stages: [{ id: "a", strategy: "chain", description: "a", retry: { whenOutputMatches: "x", rewindTo: "a" } }],
      }),
    /不能指向自身/,
  );
});

// ---------------------------------------------------------------------------
// 一致性重试循环
// ---------------------------------------------------------------------------

test("runWorkflow：一致性信号触发回退重执行（含中间阶段）", async () => {
  const manifest: WorkflowManifest = {
    id: "disclosure_test",
    name: "披露测试",
    caseType: "disclosure_analysis",
    stages: [
      { id: "extract", strategy: "chain", description: "提取特征" },
      { id: "merge", strategy: "chain", description: "融合" },
      {
        id: "consistency",
        strategy: "chain",
        description: "一致性检查",
        retry: { whenOutputMatches: "不一致|矛盾", rewindTo: "extract", maxRetries: 1 },
      },
    ],
    validation: { requireAllSteps: true },
  };
  const calls: string[] = [];
  const executor = async (stage: WorkflowStage) => {
    calls.push(stage.id);
    if (stage.id === "extract") return "特征A、特征B";
    if (stage.id === "merge") return "PFE 融合完成";
    // consistency：第一次返回不一致（触发回退），回退重跑后再执行返回一致
    const extractCalls = calls.filter(c => c === "extract").length;
    return extractCalls < 2 ? "检查发现：特征与效果不一致" : "检查通过：特征-效果因果链闭合";
  };

  const result = await runWorkflow(manifest, { input: "交底书" }, executor);
  assert.equal(result.completed, true);
  // extract 被执行 2 次（首次 + 回退重执行）
  assert.equal(calls.filter(c => c === "extract").length, 2);
  // 最终结果只有最后一次执行：3 个阶段各 1 条记录
  assert.equal(result.stages.length, 3);
  const consistency = result.stages.find(s => s.stageId === "consistency")!;
  assert.match(consistency.output, /检查通过/);
  assert.equal(consistency.degraded, false);
  assert.equal(result.degradedSteps.length, 0);
});

test("runWorkflow：超过最大回退次数 → 保留不一致输出并标记 degraded", async () => {
  const manifest: WorkflowManifest = {
    id: "disclosure_exhaust",
    name: "披露耗尽测试",
    caseType: "disclosure_analysis",
    stages: [
      { id: "extract", strategy: "chain", description: "提取特征" },
      {
        id: "consistency",
        strategy: "chain",
        description: "一致性检查",
        retry: { whenOutputMatches: "不一致", rewindTo: "extract", maxRetries: 1 },
      },
    ],
    validation: { requireAllSteps: true },
  };
  let extractCalls = 0;
  const executor = async (stage: WorkflowStage) => {
    if (stage.id === "extract") {
      extractCalls += 1;
      return "特征A";
    }
    return "检查发现：特征与效果不一致"; // 始终不一致
  };

  const result = await runWorkflow(manifest, { input: "交底书" }, executor);
  // 首次 + 回退 1 次后耗尽（maxRetries=1 → 共执行 2 轮，第 3 轮信号触发即耗尽）
  assert.equal(extractCalls, 2);
  const consistency = result.stages.find(s => s.stageId === "consistency")!;
  assert.equal(consistency.degraded, true);
  assert.match(consistency.output, /\[WORKFLOW_RETRY_EXHAUSTED\]/);
  assert.ok(result.degradedSteps.includes("consistency"));
  assert.equal(result.completed, false);
});

test("runWorkflow：输出不含信号时正常前进（不回退）", async () => {
  const manifest: WorkflowManifest = {
    id: "no_retry",
    name: "无回退测试",
    caseType: "disclosure_analysis",
    stages: [
      { id: "a", strategy: "chain", description: "a" },
      { id: "b", strategy: "chain", description: "b", retry: { whenOutputMatches: "不一致", rewindTo: "a" } },
    ],
  };
  let aCalls = 0;
  const executor = async (stage: WorkflowStage) => {
    if (stage.id === "a") {
      aCalls += 1;
      return "特征";
    }
    return "检查通过";
  };
  const result = await runWorkflow(manifest, { input: "x" }, executor);
  assert.equal(aCalls, 1);
  assert.equal(result.stages.length, 2);
  assert.equal(result.degradedSteps.length, 0);
});

test("runWorkflow：否定式表述不触发回退（未发现不一致）", async () => {
  const manifest: WorkflowManifest = {
    id: "negated_signal",
    name: "否定信号测试",
    caseType: "disclosure_analysis",
    stages: [
      { id: "extract", strategy: "chain", description: "提取特征" },
      {
        id: "consistency",
        strategy: "chain",
        description: "一致性检查",
        retry: { whenOutputMatches: "不一致|矛盾|缺少|孤立", rewindTo: "extract", maxRetries: 1 },
      },
    ],
    validation: { requireAllSteps: true },
  };
  let extractCalls = 0;
  const executor = async (stage: WorkflowStage) => {
    if (stage.id === "extract") {
      extractCalls += 1;
      return "特征A";
    }
    return "检查通过：未发现不一致、矛盾或缺少内容，各要素相互印证";
  };
  const result = await runWorkflow(manifest, { input: "交底书" }, executor);
  assert.equal(extractCalls, 1, "否定式表述不应触发回退");
  assert.equal(result.completed, true);
  assert.equal(result.degradedSteps.length, 0);
});

test("runWorkflow：回退后 stage 状态被回滚（不残留陈旧输出）", async () => {
  const manifest: WorkflowManifest = {
    id: "state_rollback",
    name: "状态回滚测试",
    caseType: "disclosure_analysis",
    stages: [
      { id: "extract", strategy: "chain", description: "提取特征" },
      {
        id: "consistency",
        strategy: "chain",
        description: "一致性检查",
        retry: { whenOutputMatches: "不一致", rewindTo: "extract", maxRetries: 1 },
      },
    ],
  };
  let round = 0;
  const executor = async (stage: WorkflowStage) => {
    if (stage.id === "extract") {
      round += 1;
      return round === 1 ? "旧特征" : "新特征";
    }
    return round === 1 ? "不一致" : "一致";
  };
  const result = await runWorkflow(manifest, { input: "x" }, executor);
  // 回退重执行后：extract 的输出是第二次的"新特征"（陈旧输出未被复用）
  const extract = result.stages.find(s => s.stageId === "extract")!;
  assert.equal(extract.output, "新特征");
  const consistency = result.stages.find(s => s.stageId === "consistency")!;
  assert.equal(consistency.output, "一致");
  assert.equal(result.degradedSteps.length, 0);
});

test("validate：retry.rewindTo 指向后续阶段被拦截", () => {
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "t",
        name: "t",
        caseType: "t",
        stages: [
          { id: "a", strategy: "chain", description: "a" },
          { id: "b", strategy: "chain", description: "b", retry: { whenOutputMatches: "x", rewindTo: "c" } },
          { id: "c", strategy: "chain", description: "c" },
        ],
      }),
    /rewindTo 指向不存在的阶段/,
  );
});

// ---------------------------------------------------------------------------
// patentDisclosureManifest
// ---------------------------------------------------------------------------

test("patentDisclosureManifest：结构与 retry 声明合法", () => {
  assert.doesNotThrow(() => validateWorkflowManifest(patentDisclosureManifest));
  assert.equal(patentDisclosureManifest.id, "patent_disclosure_v1");
  assert.equal(patentDisclosureManifest.stages.length, 8);
  const consistency = patentDisclosureManifest.stages.find(s => s.id === "consistency")!;
  assert.equal(consistency.retry?.rewindTo, "extract_problem");
  assert.match(consistency.retry!.whenOutputMatches, /不一致|矛盾|缺少|孤立/);
  // 原子声明：三路提取 + 审批门
  const atoms = patentDisclosureManifest.stages.filter(s => s.atom !== undefined).map(s => s.atom);
  assert.deepEqual([...new Set(atoms)].sort(), ["approval-gate", "extract"]);
});

test("patentDisclosureManifest：声明原子存在性校验（内置注册后）", async () => {
  const { registerBuiltinAtoms, globalAtomRegistry } = await import("../../src/patent/atoms/index.js");
  registerBuiltinAtoms();
  assert.doesNotThrow(() =>
    validateWorkflowManifest(patentDisclosureManifest, {
      atomNames: new Set(globalAtomRegistry.list().map(a => a.name)),
    }),
  );
});
