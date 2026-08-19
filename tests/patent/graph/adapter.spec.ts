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
    if (prompt.includes("一致性检查")) {
      return JSON.stringify({ consistent: true, issues: [] });
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

test("manifestToGraph: consistency 输出 consistent:false JSON → 回退 extract 三路重跑（图路径 retry 闭环）", async () => {
  let extractCalls = 0;
  let consistencyCalls = 0;
  const countingProvider: StageProvider = {
    ...provider,
    callLLM: async prompt => {
      if (prompt.includes("技术分析助手")) {
        extractCalls += 1;
        // 两轮返回值不同：回退后 state 必须来自第二轮（不残留首轮数组）
        const round = extractCalls <= 3 ? 1 : 2;
        return JSON.stringify({
          features: [`特征${round}A`, `特征${round}B`],
          problems: [`问题${round}`],
          effects: [`效果${round}`],
        });
      }
      if (prompt.includes("一致性检查")) {
        consistencyCalls += 1;
        // issues 无信号词且含否定词干扰——consistent:false 机器判据必须触发回退
        return consistencyCalls === 1
          ? JSON.stringify({ consistent: false, issues: ["问题与效果关联均缺失"] })
          : JSON.stringify({ consistent: true, issues: [] });
      }
      return provider.callLLM!(prompt);
    },
  };
  const executor = async (stage: WorkflowStage): Promise<string> => {
    if (stage.id === "report") return "披露分析报告";
    return `[${stage.id}] 完成`;
  };
  const input = "一种自动化分拣装置";
  const ctx = { input, text: input, source_text: input, extraction_input: input };
  const graph = manifestToGraph(patentDisclosureManifest, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    executor,
    provider: countingProvider,
  });
  const gr = await graph.run({ ...ctx });
  // extract 三路首轮 + 回退重跑 = 6 次；consistency 2 次；中断于 review_gate。
  assert.equal(extractCalls, 6, "extract 三路各执行 2 次（首轮 + 回退重跑）");
  assert.equal(consistencyCalls, 2, "consistency 第一轮判不一致触发回退，第二轮判一致");
  assert.equal(gr.completed, false);
  assert.equal(gr.interrupted?.node, "review_gate");
  // 回退重跑后 state 来自第二轮（无首轮残留）
  assert.deepEqual(gr.state.features, ["特征2A", "特征2B"]);
  assert.deepEqual(gr.state.problems, ["问题2"]);
  assert.equal(gr.state.consistency, JSON.stringify({ consistent: true, issues: [] }));
});

test("manifestToGraph: 回退重跑中某路提取解析失败 → 旧一代键被清理（不残留混代）", async () => {
  let extractCalls = 0;
  let consistencyCalls = 0;
  const flakyProvider: StageProvider = {
    ...provider,
    callLLM: async prompt => {
      if (prompt.includes("技术分析助手")) {
        extractCalls += 1;
        // 第 5 次 extract 调用 = 回退重跑中的 extract_features：LLM 输出非 JSON（解析失败）
        if (extractCalls === 5) return "这不是 JSON";
        return JSON.stringify({ features: ["特征A"], problems: ["问题1"], effects: ["效果1"] });
      }
      if (prompt.includes("一致性检查")) {
        consistencyCalls += 1;
        return consistencyCalls === 1
          ? JSON.stringify({ consistent: false, issues: ["问题与效果关联均缺失"] })
          : JSON.stringify({ consistent: true, issues: [] });
      }
      return provider.callLLM!(prompt);
    },
  };
  const executor = async (stage: WorkflowStage): Promise<string> => {
    if (stage.id === "report") return "披露分析报告";
    return `[${stage.id}] 完成`;
  };
  const input = "一种自动化分拣装置";
  const ctx = { input, text: input, source_text: input, extraction_input: input };
  const graph = manifestToGraph(patentDisclosureManifest, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    executor,
    provider: flakyProvider,
  });
  const gr = await graph.run({ ...ctx });
  // 解析失败的键被 rewind 清理（修复前只删 stage-id 键 → 残留首轮数组 ["特征A"] 混入下游）。
  assert.equal(extractCalls, 6, "仍完成回退重跑（extract 三路各 2 次）");
  assert.equal(gr.state.features, undefined, "features 键被清理（解析失败不残留旧一代数组）");
  assert.deepEqual(gr.state.problems, ["问题1"], "重跑成功的一路正常写回");
  assert.equal(gr.completed, false);
  assert.equal(gr.interrupted?.node, "review_gate");
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
  // consistency 走 reasoning 原子（LLM 产出 JSON），非 executor 透传。
  assert.equal(gr.state.consistency, JSON.stringify({ consistent: true, issues: [] }));
});

test("manifestToGraph: approval-gate 中断（两路径一致暂停）", async () => {
  const executor = async (stage: WorkflowStage): Promise<string> => {
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
