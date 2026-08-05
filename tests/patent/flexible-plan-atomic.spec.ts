import assert from "node:assert/strict";
import test from "node:test";
import {
  addStage,
  confirmStage,
  createFlexiblePlan,
  registerBuiltinAtoms,
  runWorkflow,
  toManifest,
  type StageProvider,
} from "../../src/patent/index.js";

/**
 * FlexiblePlan → toManifest → runWorkflow（原子执行）→ confirmStage 回流
 * 链路集成测试。
 *
 * 此前 FlexiblePlan 仅状态机单测（tests/patent/flexible-plan.spec.ts），
 * "toManifest 产出的 manifest 可被原子执行"从未验证。本文件证明激活路径
 * 可走通：计划阶段（声明 atom）经 toManifest 生成 manifest，runWorkflow 以
 * 全局原子注册表 + provider 自动执行，结果经 confirmStage 回流计划。
 */

const provider: StageProvider = {
  callLLM: async () => JSON.stringify({ features: ["双层真空结构"], problems: ["保温不足"], effects: ["长保温"] }),
};

test("FlexiblePlan 阶段（atom: extract）经 toManifest 被 runWorkflow 原子执行", async () => {
  registerBuiltinAtoms();
  let plan = createFlexiblePlan("demo-1", "disclosure_analysis");
  plan = addStage(plan, {
    id: "extract_features",
    name: "提取技术特征",
    goal: "从交底书提取技术特征",
    strategy: "sub_agent",
    atom: "extract",
    params: { extraction_type: "提取技术特征", output_key: "features" },
    status: "pending",
    artifacts: [],
    constraintIds: [],
    articleJudgments: [],
  });
  plan = addStage(plan, {
    id: "report",
    name: "撰写报告",
    goal: "汇总披露分析报告",
    strategy: "chain",
    status: "pending",
    artifacts: [],
    constraintIds: [],
    articleJudgments: [],
  });

  const manifest = toManifest(plan);
  assert.equal(manifest.id, "flexible_demo-1");
  assert.equal(manifest.stages.length, 2);
  assert.equal(manifest.stages[0]!.atom, "extract", "声明 atom 的阶段应保留原子声明");

  // 原子执行：extract 经 mock LLM 产出 features；report（无 atom）走 executor 透传。
  const executor = async (): Promise<string> => "透传输入";
  const result = await runWorkflow(manifest, { text: "交底书原文" }, executor, {
    handlers: undefined, // 缺省全局注册表（registerBuiltinAtoms 已装配）
    provider,
  });

  const extractStage = result.stages.find(s => s.stageId === "extract_features");
  assert.ok(extractStage, "extract 阶段应执行");
  assert.equal(extractStage!.degraded, false);
  assert.match(extractStage!.output, /双层真空结构/, "extract 主输出应含 LLM 产出的 features");
  const reportStage = result.stages.find(s => s.stageId === "report");
  assert.equal(reportStage?.degraded, false, "无 atom 阶段透传不降级");
});

test("执行结果经 confirmStage 回流：已确认阶段不再进入下一次 manifest", async () => {
  registerBuiltinAtoms();
  let plan = createFlexiblePlan("demo-2", "disclosure_analysis");
  plan = addStage(plan, {
    id: "extract_problem",
    name: "提取技术问题",
    goal: "提取待解决的技术问题",
    strategy: "sub_agent",
    atom: "extract",
    params: { extraction_type: "提取待解决的技术问题", output_key: "problems" },
    status: "pending",
    artifacts: [],
    constraintIds: [],
    articleJudgments: [],
  });
  plan = addStage(plan, {
    id: "novelty_check",
    name: "新颖性初判",
    goal: "逐特征新颖性初判",
    strategy: "chain",
    atom: "novelty",
    status: "pending",
    artifacts: [],
    constraintIds: [],
    articleJudgments: [],
  });

  // 第一次执行 extract_problem
  const firstManifest = toManifest(plan);
  const first = await runWorkflow(firstManifest, { text: "交底书" }, async () => "", {
    provider,
  });
  assert.ok(first.stages.find(s => s.stageId === "extract_problem")?.degraded === false);

  // 确认 extract_problem 完成 → 回流计划
  plan = confirmStage(plan, "extract_problem");
  const secondManifest = toManifest(plan);
  assert.deepEqual(
    secondManifest.stages.map(s => s.id),
    ["novelty_check"],
    "已确认阶段不应再进入待执行 manifest",
  );
  // 剩余阶段仍可执行（novelty 原子）
  const second = await runWorkflow(secondManifest, { text: "交底书", features: ["特征A"] }, async () => "", {
    provider,
  });
  const noveltyStage = second.stages.find(s => s.stageId === "novelty_check");
  assert.ok(noveltyStage, "剩余阶段应可执行");
});
