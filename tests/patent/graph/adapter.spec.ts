import assert from "node:assert/strict";
import test from "node:test";
import {
  GraphBuilder,
  InterruptStageError,
  StageHandlerRegistry,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  handlerNode,
  manifestToGraph,
  patentDisclosureManifest,
  registerBuiltinAtoms,
  runWorkflow,
  type StageHandler,
  type StageProvider,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowStage,
} from "../../../src/patent/index.js";

registerBuiltinAtoms();

// ---------------------------------------------------------------------------
// mock provider（prompt 特征匹配，对齐 tests/patent/atoms.spec.ts 风格）
// ---------------------------------------------------------------------------

const provider: StageProvider = {
  callLLM: async prompt => {
    if (prompt.includes("技术分析助手")) {
      return JSON.stringify({ features: ["特征A", "特征B"], problems: ["问题1"], effects: ["效果1"] });
    }
    if (prompt.includes("交底书分析师")) {
      return JSON.stringify({
        scores: [
          { feature: "特征A", score: 0.9, reason: "原文记载" },
          { feature: "特征B", score: 0.3, reason: "推断" },
        ],
        feedback: "特征B依据不足",
      });
    }
    if (prompt.includes("检索关键词")) {
      return JSON.stringify({ keywords: ["分拣", "自动化", "传感器"] });
    }
    if (prompt.includes("新颖性分析专家")) {
      return JSON.stringify({
        assessments: [{ feature: "特征A", prior_art: "D1", disclosed: false, reasoning: "未公开" }],
        conclusion: "具备新颖性（置信度 0.8）",
      });
    }
    if (prompt.includes("权利要求撰写专家")) {
      return JSON.stringify({
        claims: ["1. 一种自动化分拣装置，其特征在于，包括传送带与识别传感器。"],
        notes: "独立权利要求",
      });
    }
    return "默认推理结论";
  },
  search: async query => [{ title: `文献: ${query}`, snippet: "摘要", url: "https://example.com/1" }],
};

const okExecutor = (stage: WorkflowStage, ctx: WorkflowContext): Promise<string> =>
  Promise.resolve(`[${stage.id}] 完成。输入: ${ctx.input ?? ""}`);

// ---------------------------------------------------------------------------
// handlerNode
// ---------------------------------------------------------------------------

test("handlerNode: 普通 handler 作为图节点执行", async () => {
  const handler: StageHandler = {
    name: "t",
    category: "extract",
    execute: async () => ({ out: "hello" }),
  };
  const builder = new GraphBuilder();
  builder.addNode("t", handlerNode(handler)).addEdge("t", "__end__");
  const graph = builder.compile("t");
  const result = await graph.run({});
  assert.equal(result.state.out, "hello");
});

test("handlerNode: InterruptStageError 转 GraphInterruptError（引擎暂停）", async () => {
  const handler: StageHandler = {
    name: "approve",
    category: "gate",
    execute: async () => {
      throw new InterruptStageError("approve", "需要确认", { ctx: "x" });
    },
  };
  const builder = new GraphBuilder();
  builder
    .addNode("approve", handlerNode(handler))
    .addNode("after", async () => ({ never: true }))
    .addEdge("approve", "after");
  const graph = builder.compile("approve");
  const result = await graph.run({});
  assert.equal(result.completed, false);
  assert.deepEqual(result.interrupted, { node: "approve", message: "需要确认", data: { ctx: "x" } });
  assert.equal(result.state.never, undefined);
});

// ---------------------------------------------------------------------------
// manifestToGraph 与 runWorkflow 等价性
// ---------------------------------------------------------------------------

test("manifestToGraph: 简单线性 manifest 与 runWorkflow 输出等价", async () => {
  const manifest: WorkflowManifest = {
    id: "equiv_linear",
    name: "线性等价",
    caseType: "test",
    stages: [
      { id: "s1", strategy: "chain", description: "一" },
      { id: "s2", strategy: "chain", description: "二" },
      { id: "s3", strategy: "chain", description: "三" },
    ],
  };
  const ctx = { input: "输入" };
  const wf = await runWorkflow(manifest, ctx, okExecutor);
  const graph = manifestToGraph(manifest, { executor: okExecutor });
  const gr = await graph.run({ ...ctx });
  assert.equal(gr.completed, wf.completed);
  for (const stage of manifest.stages) {
    assert.equal(gr.state[stage.id], wf.stages.find(s => s.stageId === stage.id)?.output);
  }
});

test("manifestToGraph: retry 回退与 runWorkflow 等价（回退重跑 extract）", async () => {
  const retryManifest: WorkflowManifest = {
    id: "equiv_retry",
    name: "回退等价",
    caseType: "test",
    stages: [
      {
        id: "extract",
        strategy: "chain",
        description: "提取",
        atom: "extract",
        params: { extraction_type: "提取技术特征", output_key: "features" },
      },
      {
        id: "check",
        strategy: "chain",
        description: "一致性检查",
        retry: { whenOutputMatches: "不一致", rewindTo: "extract", maxRetries: 1 },
      },
      { id: "done", strategy: "chain", description: "结束" },
    ],
  };
  // 两路径独立计数器（共享闭包会互相消耗）。
  const wfExecutor = makeFlakyExecutor();
  const grExecutor = makeFlakyExecutor();
  const ctx = { input: "一种装置" };

  const wf = await runWorkflow(retryManifest, ctx, wfExecutor.fn, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider,
  });
  const graph = manifestToGraph(retryManifest, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    executor: grExecutor.fn,
    provider,
  });
  const gr = await graph.run({ ...ctx });

  // 回退触发：extract 被重跑两次，check 最终输出 "一致"。
  assert.equal(wf.stages.find(s => s.stageId === "check")?.output, "一致");
  assert.equal(gr.state.check, "一致");
  assert.equal(wfExecutor.calls(), 2);
  assert.equal(grExecutor.calls(), 2);
  // 两路径 stage 输出对齐。
  for (const stage of retryManifest.stages) {
    assert.equal(gr.state[stage.id], wf.stages.find(s => s.stageId === stage.id)?.output);
  }
});

/** 第 1 次返回"存在不一致"（触发回退），之后"一致"；记录调用次数。 */
function makeFlakyExecutor(): { fn: (stage: WorkflowStage) => Promise<string>; calls: () => number } {
  const state = { calls: 0 };
  return {
    calls: () => state.calls,
    fn: async (stage: WorkflowStage) => {
      if (stage.id === "check") {
        state.calls += 1;
        return state.calls === 1 ? "存在不一致" : "一致";
      }
      return `[${stage.id}] 完成`;
    },
  };
}

test("manifestToGraph: disclosure 全流程（放行审批）与 runWorkflow 输出等价", async () => {
  // 放行 approval-gate：注入不中断的自定义 handler。
  const passthroughApproval: StageHandler = {
    name: "approval-gate",
    category: "gate",
    execute: async () => ({ review_passed: true }),
  };
  const handlers = new StageHandlerRegistry();
  for (const h of globalStageHandlerRegistry.list()) handlers.register(h);
  handlers.register(passthroughApproval);

  const executor = async (stage: WorkflowStage): Promise<string> => {
    if (stage.id === "consistency") return "PFE 一致，因果链闭合";
    if (stage.id === "report") return "披露分析报告：方案具备创新点与保护建议";
    return `[${stage.id}] 完成`;
  };
  // 对齐 patent_workflow_run 的 workflowCtx 映射：input/text/source_text/extraction_input 同一份输入。
  const input = "一种自动化分拣装置，包含传送带、识别传感器与分拣机械臂";
  const ctx = { input, text: input, source_text: input, extraction_input: input };

  const wf = await runWorkflow(patentDisclosureManifest, ctx, executor, {
    handlers,
    atoms: globalAtomRegistry,
    provider,
  });
  // runWorkflow 对 approval-gate 放行（空输出）固有地标记 review_gate 降级。
  assert.equal(wf.completed, false);
  assert.deepEqual(wf.degradedSteps, ["review_gate"]);

  const graph = manifestToGraph(patentDisclosureManifest, { handlers, atoms: globalAtomRegistry, executor, provider });
  const gr = await graph.run({ ...ctx });
  assert.equal(gr.completed, true);
  assert.deepEqual(gr.degraded, []);

  // 等价性对比：review_gate 除外（runWorkflow 空输出→degraded，图无此概念）。
  for (const stage of patentDisclosureManifest.stages) {
    if (stage.id === "review_gate") continue;
    const wfOutput = wf.stages.find(s => s.stageId === stage.id)?.output;
    assert.equal(gr.state[stage.id], wfOutput, `阶段 ${stage.id} 输出对齐`);
  }
});

test("manifestToGraph: approval-gate 中断（两路径一致暂停）", async () => {
  const executor = async (stage: WorkflowStage): Promise<string> => {
    if (stage.id === "consistency") return "PFE 一致，因果链闭合";
    if (stage.id === "report") return "报告";
    return `[${stage.id}] 完成`;
  };
  const input = "一种自动化分拣装置";
  const ctx = { input, text: input, source_text: input, extraction_input: input };

  const wf = await runWorkflow(patentDisclosureManifest, ctx, executor, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    provider,
  });
  assert.equal(wf.completed, false);
  assert.ok(wf.interrupted);

  const graph = manifestToGraph(patentDisclosureManifest, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    executor,
    provider,
  });
  const gr = await graph.run({ ...ctx });
  assert.equal(gr.completed, false);
  assert.equal(gr.interrupted?.node, "review_gate");
  // 中断前已执行阶段输出对齐。
  for (const stage of patentDisclosureManifest.stages) {
    if (stage.id === "review_gate" || stage.id === "draft_claims") continue;
    assert.equal(gr.state[stage.id], wf.stages.find(s => s.stageId === stage.id)?.output, `阶段 ${stage.id}`);
  }
});

test("manifestToGraph: 未知 atom fail-fast", () => {
  const manifest: WorkflowManifest = {
    id: "bad",
    name: "未知原子",
    caseType: "test",
    stages: [{ id: "s1", strategy: "chain", description: "一", atom: "no-such-atom" }],
  };
  assert.throws(() => manifestToGraph(manifest), /未知 atom/);
});
