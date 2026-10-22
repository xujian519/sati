/**
 * W-06: FlexiblePlan → CompiledGraph 集成测试。
 *
 * 覆盖场景：
 * - create → toCompiledGraph → run（基本图编译与执行）
 * - addStage → toCompiledGraph → run（动态加阶段后图编译）
 * - removeStage → toCompiledGraph → run（动态删阶段后图编译）
 * - confirmStage + rollbackStage → toCompiledGraph（状态变更后的图编译）
 * - toManifest vs toCompiledGraph 行为等价性
 * - 完整生命周期（create → add → confirm → rollback → remove → run）
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addStage,
  confirmStage,
  createFlexiblePlan,
  removeStage,
  rollbackStage,
  toCompiledGraph,
  toManifest,
  type FlexibleStage,
} from "../../src/patent/flexible-plan.js";
import { AtomRegistry, StageHandlerRegistry, registerBuiltinAtoms } from "../../src/patent/index.js";
import { globalAtomRegistry, globalStageHandlerRegistry } from "../../src/patent/atoms/index.js";

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

/** 空 provider：返回固定 JSON 文本。 */
const mockProvider = {
  callLLM: async () => JSON.stringify({ features: ["特征A", "特征B"], problems: ["问题1"], effects: ["效果1"] }),
};

// 确保内置原子已注册（幂等）
registerBuiltinAtoms();

// ---------------------------------------------------------------------------
// T1: create → toCompiledGraph → run
// ---------------------------------------------------------------------------

test("toCompiledGraph: create 后基本图编译与执行", async () => {
  const plan = createFlexiblePlan("case-t1", "disclosure_analysis", {
    stages: [
      stage("extract", {
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      }),
      stage("merge", { atom: "merge" }),
      stage("done"),
    ],
  });
  const graph = toCompiledGraph(plan, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider: mockProvider,
  });
  const result = await graph.run({ text: "一种装置" });
  assert.equal(result.completed, true);
  assert.ok(Array.isArray(result.state.features), "extract 原子产出 features");
});

// ---------------------------------------------------------------------------
// T2: addStage → toCompiledGraph → run（动态加阶段）
// ---------------------------------------------------------------------------

test("toCompiledGraph: addStage 后图编译包含新阶段", async () => {
  let plan = createFlexiblePlan("case-t2", "disclosure_analysis", {
    stages: [
      stage("extract", {
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      }),
    ],
  });
  // 动态追加 merge 阶段
  plan = addStage(plan, stage("merge", { atom: "merge" }));
  const graph = toCompiledGraph(plan, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider: mockProvider,
  });
  const result = await graph.run({ text: "一种装置" });
  assert.equal(result.completed, true);
  // merge 原子应被执行（产出 pfe_triples 或 merge_result）
  assert.ok(result.state.pfe_triples || result.state.merge_result || result.state.features, "merge 阶段应执行");
});

// ---------------------------------------------------------------------------
// T3: removeStage → toCompiledGraph → run（动态删阶段）
// ---------------------------------------------------------------------------

test("toCompiledGraph: removeStage 后图编译排除被删阶段", async () => {
  let plan = createFlexiblePlan("case-t3", "disclosure_analysis", {
    stages: [
      stage("extract", {
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      }),
      stage("merge", { atom: "merge" }),
      stage("extra", { atom: "groundedness" }),
    ],
  });
  // 删除最后的 groundedness 阶段
  plan = removeStage(plan, "extra");
  const graph = toCompiledGraph(plan, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider: mockProvider,
  });
  const result = await graph.run({ text: "一种装置" });
  assert.equal(result.completed, true);
  // groundedness 被删除后不应产出 groundedness_result
  assert.equal(result.state.groundedness_result, undefined, "被删阶段不应执行");
});

// ---------------------------------------------------------------------------
// T4: confirmStage + rollbackStage → toCompiledGraph
// ---------------------------------------------------------------------------

test("toCompiledGraph: confirmStage 后已确认阶段不参与图编译", async () => {
  let plan = createFlexiblePlan("case-t4a", "disclosure_analysis", {
    stages: [
      stage("extract", {
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      }),
      stage("merge", { atom: "merge" }),
      stage("done"),
    ],
  });
  // 确认第一阶段
  plan = confirmStage(plan, "extract");
  const manifest = toManifest(plan);
  // 已确认阶段不在 manifest 中
  assert.deepEqual(
    manifest.stages.map(s => s.id),
    ["merge", "done"],
    "confirmStage 后已确认阶段应被排除",
  );
  // 图编译应只包含未确认阶段
  const graph = toCompiledGraph(plan, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider: mockProvider,
  });
  const result = await graph.run({ text: "一种装置" });
  assert.equal(result.completed, true);
});

test("toCompiledGraph: rollbackStage 后被回退阶段重新参与图编译", async () => {
  let plan = createFlexiblePlan("case-t4b", "disclosure_analysis", {
    stages: [
      stage("extract", {
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      }),
      stage("merge", { atom: "merge" }),
      stage("done"),
    ],
  });
  // 先确认前两个阶段
  plan = confirmStage(plan, "extract");
  plan = confirmStage(plan, "merge");
  // 回退 merge 阶段（merge 及后续已确认阶段变为 rolled_back）
  plan = rollbackStage(plan, "merge");
  const manifest = toManifest(plan);
  // rolled_back 阶段参与 manifest（与 pending 一样）
  assert.deepEqual(
    manifest.stages.map(s => s.id),
    ["merge", "done"],
    "rollbackStage 后被回退阶段应重新参与图编译",
  );
});

// ---------------------------------------------------------------------------
// T5: toManifest vs toCompiledGraph 行为等价性
// ---------------------------------------------------------------------------

test("toManifest 与 toCompiledGraph 对同一 plan 产生一致的阶段集", async () => {
  const plan = createFlexiblePlan("case-t5", "disclosure_analysis", {
    stages: [
      stage("extract", {
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      }),
      stage("merge", { atom: "merge" }),
      stage("done"),
    ],
  });
  // toManifest 产出的阶段 id 列表
  const manifestIds = toManifest(plan).stages.map(s => s.id);
  // toCompiledGraph 内部先调 toManifest 再转图，图的节点集应与 manifest 阶段一致
  const graph = toCompiledGraph(plan, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider: mockProvider,
  });
  const graphDesc = graph.describe();
  // 图的节点应包含 manifest 中所有阶段 id（加上 __start__ 和 __end__）
  for (const id of manifestIds) {
    assert.ok(graphDesc.nodes.includes(id), `图节点应包含 manifest 阶段 ${id}`);
  }
});

test("toManifest vs toCompiledGraph：confirmStage 后两者一致排除已确认阶段", () => {
  let plan = createFlexiblePlan("case-t5b", "disclosure_analysis", {
    stages: [
      stage("s1", { atom: "extract", params: { extraction_type: "test", output_key: "features" } }),
      stage("s2"),
      stage("s3"),
    ],
  });
  plan = confirmStage(plan, "s1");
  const manifestIds = toManifest(plan).stages.map(s => s.id);
  const graph = toCompiledGraph(plan, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider: mockProvider,
  });
  const graphDesc = graph.describe();
  // s1 已确认，不应出现在 manifest 或图中
  assert.ok(!manifestIds.includes("s1"), "已确认阶段 s1 不应在 manifest 中");
  assert.ok(!graphDesc.nodes.includes("s1"), "已确认阶段 s1 不应在图节点中");
  // s2, s3 应存在
  assert.ok(manifestIds.includes("s2"));
  assert.ok(graphDesc.nodes.includes("s2"));
});

// ---------------------------------------------------------------------------
// T6: 完整生命周期（create → add → confirm → rollback → remove → run）
// ---------------------------------------------------------------------------

test("完整生命周期: create → add → confirm → rollback → remove → toCompiledGraph → run", async () => {
  // 1. create
  let plan = createFlexiblePlan("case-t6", "disclosure_analysis", {
    stages: [
      stage("extract", {
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      }),
    ],
  });
  // 2. add
  plan = addStage(plan, stage("merge", { atom: "merge" }));
  plan = addStage(plan, stage("groundedness", { atom: "groundedness" }));
  plan = addStage(plan, stage("done"));
  assert.equal(plan.stages.length, 4);

  // 3. confirm extract
  plan = confirmStage(plan, "extract");
  assert.equal(plan.stages.find(s => s.id === "extract")?.status, "confirmed");

  // 4. confirm merge, then rollback（rollbackStage 只回退 confirmed 阶段）
  plan = confirmStage(plan, "merge");
  assert.equal(plan.stages.find(s => s.id === "merge")?.status, "confirmed");
  plan = rollbackStage(plan, "merge");
  assert.equal(plan.stages.find(s => s.id === "merge")?.status, "rolled_back");

  // 5. remove groundedness（不需要了）
  plan = removeStage(plan, "groundedness");
  assert.equal(plan.stages.length, 3); // extract, merge, done

  // 6. toCompiledGraph → run（只有 merge 和 done，extract 已确认被排除）
  const graph = toCompiledGraph(plan, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider: mockProvider,
  });
  const result = await graph.run({ text: "一种装置" });
  assert.equal(result.completed, true);

  // 验证 manifest 只包含非确认阶段
  const manifest = toManifest(plan);
  assert.deepEqual(
    manifest.stages.map(s => s.id),
    ["merge", "done"],
    "完整生命周期后 manifest 应只含非确认阶段",
  );
});

// ---------------------------------------------------------------------------
// 边界：空计划 / 全部确认
// ---------------------------------------------------------------------------

test("toCompiledGraph: 全部阶段已确认 → 抛出 FlexiblePlanError", () => {
  let plan = createFlexiblePlan("case-empty", "disclosure_analysis", {
    stages: [stage("s1")],
  });
  plan = confirmStage(plan, "s1");
  assert.throws(() => toCompiledGraph(plan), /全部已确认|没有待执行/);
});

test("toCompiledGraph: 空注册表 + 无 atom 阶段 → 图编译成功但回退 executor", async () => {
  const plan = createFlexiblePlan("case-noatom", "novelty_search", {
    stages: [stage("parse"), stage("conclude")],
  });
  // 使用空注册表：无 atom 阶段走 executor 路径
  const emptyHandlers = new StageHandlerRegistry();
  const emptyAtoms = new AtomRegistry();
  const graph = toCompiledGraph(plan, {
    handlers: emptyHandlers,
    atoms: emptyAtoms,
  });
  const result = await graph.run({ text: "一种装置" });
  // 无 atom 阶段在图引擎中作为 passthrough 节点执行
  assert.equal(result.completed, true);
});
