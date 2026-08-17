import assert from "node:assert/strict";
import test from "node:test";
import {
  AtomRegistry,
  StageHandlerRegistry,
  WorkflowError,
  patentInventivenessManifest,
  patentNoveltyManifest,
  registerBuiltinAtoms,
  runWorkflow,
  validateWorkflowManifest,
  type WorkflowContext,
  type WorkflowStage,
  type WorkflowManifest,
} from "../../src/patent/index.js";

// 审批门测试需要全局原子注册表（approval-gate handler）；幂等。
registerBuiltinAtoms();

function okExecutor(stage: WorkflowStage, ctx: WorkflowContext): Promise<string> {
  return Promise.resolve(`[${stage.id}] 完成。输入: ${ctx.input ?? ""}`);
}

test("validateWorkflowManifest rejects malformed manifests", () => {
  assert.throws(() => validateWorkflowManifest({ id: "", name: "x", caseType: "y", stages: [] }), WorkflowError);
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "w",
        name: "x",
        caseType: "y",
        stages: [
          { id: "a", strategy: "chain", description: "d" },
          { id: "a", strategy: "chain", description: "d" },
        ],
      }),
    WorkflowError,
  );
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "w",
        name: "x",
        caseType: "y",
        stages: [{ id: "a", strategy: "magic" as unknown as WorkflowStage["strategy"], description: "d" }],
      }),
    WorkflowError,
  );
});

test("runWorkflow executes all stages and reports completion", async () => {
  const result = await runWorkflow(patentNoveltyManifest, { input: "一种自动化分拣装置" }, okExecutor);
  assert.equal(result.manifestId, "patent_novelty_v1");
  assert.equal(result.completed, true);
  assert.equal(result.stages.length, 5);
  assert.deepEqual(result.degradedSteps, []);
  assert.match(result.summary, /5\/5 阶段完成/);
});

test("runWorkflow marks degraded stages without aborting", async () => {
  const flakyExecutor = (stage: WorkflowStage): Promise<string> => {
    if (stage.id === "compare") return Promise.resolve("");
    return Promise.resolve(`[${stage.id}] 完成`);
  };
  const result = await runWorkflow(patentNoveltyManifest, {}, flakyExecutor);
  assert.equal(result.completed, false);
  assert.deepEqual(result.degradedSteps, ["compare"]);
  assert.ok(result.stages.find(s => s.stageId === "compare")?.degraded);
});

test("runWorkflow retries failed stages up to maxRetries", async () => {
  const manifest: WorkflowManifest = {
    id: "retry_wf",
    name: "重试工作流",
    caseType: "test",
    stages: [{ id: "s1", strategy: "chain", description: "先失败后成功" }],
    validation: { maxRetries: 3 },
  };
  let calls = 0;
  const executor = async (): Promise<string> => {
    calls += 1;
    if (calls < 3) throw new Error("临时失败");
    return "成功输出";
  };
  const result = await runWorkflow(manifest, {}, executor);
  assert.equal(result.stages[0].output, "成功输出");
  assert.equal(result.stages[0].degraded, false);
  assert.equal(calls, 3);
});

test("novelty manifest covers the full five-stage analysis chain", () => {
  assert.equal(patentNoveltyManifest.stages.length, 5);
  assert.deepEqual(
    patentNoveltyManifest.stages.map(s => s.id),
    ["parse", "search", "compare", "conclude", "approval"],
  );
  assert.equal(patentNoveltyManifest.caseType, "novelty_search");
  assert.deepEqual(
    patentNoveltyManifest.stages.map(s => s.strategy),
    ["chain", "react", "chain", "chain", "chain"],
  );
});

test("runWorkflow：stage.params 合并进 handler 执行态（handler 可读）", async () => {
  const registry = new StageHandlerRegistry();
  registry.register({
    name: "echo-params",
    category: "extract" as const,
    execute: async ({ state }) => ({ echoed: String(state.param_key ?? "") }),
  });
  const atoms = new AtomRegistry();
  atoms.register({
    name: "echo-params",
    description: "echo",
    category: "extract",
    inputSchema: ["param_key"],
    outputSchema: ["echoed"],
  });
  const manifest: WorkflowManifest = {
    id: "params_wf",
    name: "params",
    caseType: "test",
    stages: [
      {
        id: "echo",
        strategy: "chain",
        description: "echo",
        atom: "echo-params",
        params: { param_key: "from-stage" },
      },
    ],
  };
  const result = await runWorkflow(manifest, {}, undefined, { handlers: registry, atoms });
  assert.equal(result.completed, true);
  assert.equal(result.stages[0]!.output, "from-stage", "handler 应读到 stage.params");
});

test("runWorkflow：无 params 时 handler 执行态与共享 state 一致", async () => {
  const registry = new StageHandlerRegistry();
  registry.register({
    name: "echo-ctx",
    category: "extract" as const,
    execute: async ({ state }) => ({ echoed: String(state.input ?? "") }),
  });
  const atoms = new AtomRegistry();
  atoms.register({
    name: "echo-ctx",
    description: "echo",
    category: "extract",
    inputSchema: ["input"],
    outputSchema: ["echoed"],
  });
  const manifest: WorkflowManifest = {
    id: "ctx_wf",
    name: "ctx",
    caseType: "test",
    stages: [{ id: "echo", strategy: "chain", description: "echo", atom: "echo-ctx" }],
  };
  const result = await runWorkflow(manifest, { input: "from-ctx" }, undefined, { handlers: registry, atoms });
  assert.equal(result.stages[0]!.output, "from-ctx");
});

test("inventiveness manifest covers the full eight-stage three-step chain", () => {
  assert.equal(patentInventivenessManifest.id, "patent_inventiveness_v1");
  assert.equal(patentInventivenessManifest.name, "专利创造性分析");
  assert.equal(patentInventivenessManifest.caseType, "inventiveness_analysis");
  assert.equal(patentInventivenessManifest.stages.length, 8);
  assert.deepEqual(
    patentInventivenessManifest.stages.map(s => s.id),
    ["parse", "search", "closest", "diff", "hint", "secondary", "conclude", "approval"],
  );
  assert.deepEqual(
    patentInventivenessManifest.stages.map(s => s.strategy),
    ["chain", "react", "chain", "chain", "chain", "chain", "chain", "chain"],
  );
});

test("runWorkflow executes inventiveness manifest stages and reports completion", async () => {
  const result = await runWorkflow(patentInventivenessManifest, { input: "一种散热装置" }, okExecutor);
  assert.equal(result.manifestId, "patent_inventiveness_v1");
  assert.equal(result.completed, true);
  assert.equal(result.stages.length, 8);
  assert.deepEqual(result.degradedSteps, []);
  assert.match(result.summary, /8\/8 阶段完成/);
});

test("runWorkflow marks degraded inventiveness stage without aborting", async () => {
  const flakyExecutor = (stage: WorkflowStage): Promise<string> => {
    if (stage.id === "hint") return Promise.resolve("");
    return Promise.resolve(`[${stage.id}] 完成`);
  };
  const result = await runWorkflow(patentInventivenessManifest, {}, flakyExecutor);
  assert.equal(result.completed, false);
  assert.deepEqual(result.degradedSteps, ["hint"]);
  assert.ok(result.stages.find(s => s.stageId === "hint")?.degraded);
});

// ---------------------------------------------------------------------------
// 审批门 HITL：无批准 → 暂停；approvalGrants 命中 → 放行继续
// ---------------------------------------------------------------------------

const approvalGateManifest: WorkflowManifest = {
  id: "approval_gate_test",
  name: "审批门测试",
  caseType: "patent",
  stages: [
    { id: "analyze", strategy: "chain", description: "分析" },
    {
      id: "review_gate",
      strategy: "chain",
      description: "人工复核",
      atom: "approval-gate",
      params: { review_context: "请人工确认分析结论" },
    },
    { id: "conclude", strategy: "chain", description: "结论" },
  ],
};

test("runWorkflow：审批门无批准时暂停返回 interrupted（不执行后续阶段）", async () => {
  const result = await runWorkflow(approvalGateManifest, { input: "x" }, okExecutor);
  assert.equal(result.completed, false);
  assert.ok(result.interrupted);
  assert.equal(result.interrupted.stageId, "review_gate");
  assert.equal(result.interrupted.data.guardrail_level, "high");
  // 审批门后的阶段不执行
  assert.ok(!result.stages.find(s => s.stageId === "conclude"));
});

test("runWorkflow：approvalGrants 命中已批准审批门 → 跳过放行并继续后续阶段", async () => {
  const result = await runWorkflow(approvalGateManifest, { input: "x" }, okExecutor, {
    approvalGrants: ["review_gate"],
  });
  assert.equal(result.completed, true);
  assert.equal(result.interrupted, undefined);
  const gate = result.stages.find(s => s.stageId === "review_gate")!;
  assert.equal(gate.output, "APPROVED");
  assert.equal(gate.degraded, false);
  assert.ok(
    result.stages.find(s => s.stageId === "conclude"),
    "审批门后的阶段应继续执行",
  );
});

test("runWorkflow：approvalGrants 未命中时审批门照常暂停", async () => {
  const result = await runWorkflow(approvalGateManifest, { input: "x" }, okExecutor, {
    approvalGrants: ["other_gate"],
  });
  assert.equal(result.completed, false);
  assert.ok(result.interrupted);
  assert.equal(result.interrupted.stageId, "review_gate");
});
