/**
 * 跨链路口径一致性 fixture（issue #358）。
 *
 * 同一份 `WorkflowManifest` 分别经两条链路执行：
 * - **图路径**：`manifestToGraph(...)` + 检查点（Graph JSON 形态，放行按被批准检查点的待执行门 id）；
 * - **manifest 路径**：`runWorkflow(...)`（收口文本形态，放行按 `approvalGrants: stageId[]`）。
 *
 * 本文件是「两条链路是否一致」的**唯一判据 home**：差异不是被静默容忍，而是必须登记在
 * `LINK_DIFFERENCES`（含理由与来源）并由用例表逐条实证——两向都关死：
 * - 出现**未登记**的差异 ⇒ 该用例的实测差异集与期望集不等而转红；
 * - 登记了但**无人实证**的差异类型 ⇒ 覆盖断言转红（防清单过宽/僵尸条目）；
 * - 差异**消失**（有人把两条链路收敛了）⇒ 实测集变小、同样转红（清单不会腐烂）。
 *
 * 刻意取舍的三处「不做」（陷阱 1/6/7/8、双链路字段提取）见
 * `docs/problem-atomization-minimal-plan.md:73,199`，其性质属"功能未提取"，不表现为
 * 本 fixture 可观测的产出差异，故不入登记表。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_NODES_KEY,
  ApprovalGateHandler,
  GraphBuilder,
  type GraphRunResult,
  InMemoryCheckpointStore,
  StageHandlerRegistry,
  type StageProvider,
  grantApproval,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  handlerNode,
  manifestToGraph,
  patentDisclosureManifest,
  registerBuiltinAtoms,
  runGraphWithCheckpoints,
  runWorkflow,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowRunResult,
  type WorkflowStage,
} from "../../../src/patent/index.js";

registerBuiltinAtoms();

/** 与 `runWorkflow` 的 executor 形参同构（barrel 未导出 `Executor`，故就地声明）。 */
type Executor = (stage: WorkflowStage, ctx: WorkflowContext) => Promise<string>;

// ---------------------------------------------------------------------------
// 共同夹具：provider / executor
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

const okExecutor: Executor = (stage: WorkflowStage, ctx) =>
  Promise.resolve(`[${stage.id}] 完成。输入: ${ctx.input ?? ""}`);

/** 第 1 次返回"存在不一致"（触发回退），之后"一致"；记录调用次数。 */
function makeFlakyExecutor(): { fn: Executor; calls: () => number } {
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

// ---------------------------------------------------------------------------
// 有意差异登记表
// ---------------------------------------------------------------------------

/**
 * 两条链路**有意**差异的类型。新增类型必须在这里登记理由与来源，并在用例表里至少被一个
 * 用例实证（`DiffKind` 由本表派生 ⇒ 用例写未登记的类型名是编译错误）。
 */
const LINK_DIFFERENCES = {
  /** 完成态不同（仅作为降级/错误通道差异的伴生表现，理由见对应通道条目）。 */
  completion: {
    reason: "降级/错误通道差异的伴生表现：manifest 路径把「阶段未产出」计入 completed=false",
    source: "src/patent/graph/README.md §与现有 Workflow 的关系（已知差异）",
  },
  /** 某阶段的输出文本不同。 */
  "stage-output": {
    reason:
      "错误重试通道：manifest 路径对 handler 错误重试 maxRetries 次并把错误写进 [WORKFLOW_DEGRADED] 输出文本；图路径只执行一次、错误转节点级降级标记（该阶段无输出）",
    source: "src/patent/graph/README.md §与现有 Workflow 的关系（已知差异·错误重试）",
  },
  /** 降级的表达通道不同（阶段级 degradedSteps vs state 级降级标记）。 */
  "degradation-report": {
    reason:
      "manifest 路径按阶段输出进 degradedSteps（空输出即 degraded、completed=false）；图路径无阶段级 degraded 概念，降级只体现为 state 键 <key>__degradation（GraphRunResult.degraded）",
    source: "src/patent/graph/README.md §与现有 Workflow 的关系（已知差异·降级判定通道）",
  },
} as const;

/** 已登记的有意差异类型（由登记表派生 ⇒ 用例写未登记的类型名是编译错误）。 */
type DiffKind = keyof typeof LINK_DIFFERENCES;

// ---------------------------------------------------------------------------
// 比对：把两条链路的产物映射到同一比对视域，算出**实测差异集**
// ---------------------------------------------------------------------------

type LinkView = {
  completed: boolean;
  interrupted?: string;
  /** stageId → 该阶段输出。 */
  outputs: Record<string, unknown>;
  /**
   * **阶段级**降级集合：
   * - manifest 路径 = `degradedSteps`（本身即阶段粒度）；
   * - 图路径 = state 里存在 `<stageId>__degradation` 键的阶段（引擎 node_failed 标记与
   *   adapter not_implemented 标记都按节点名写键）。
   * ⚠️ 图路径**原子内部**的降级按输出键写（`<outputKey>__degradation`，如
   * `features__degradation`）——那不是阶段级事实，故不进本字段，而是表现为"manifest 路径
   * 报降级 / 图路径阶段级不报"的通道差异（见 `LINK_DIFFERENCES["degradation-report"]`）。
   */
  degradedStages: string[];
  /** 降级标记**条数**（manifest 路径 = degradedSteps 长度；图路径 = `degraded` 标记数）。 */
  degradedCount: number;
};

/** 差异项：`<类型>` 或 `<类型>:<明细>`（明细如所在 stage id，失败信息里直接定位）。 */
type Diff = DiffKind | `${DiffKind}:${string}`;

function manifestView(wf: WorkflowRunResult): LinkView {
  return {
    completed: wf.completed,
    interrupted: wf.interrupted?.stageId,
    outputs: Object.fromEntries(wf.stages.map(s => [s.stageId, s.output])),
    degradedStages: [...wf.degradedSteps].sort(),
    degradedCount: wf.degradedSteps.length,
  };
}

function graphView(gr: GraphRunResult, stageIds: string[]): LinkView {
  return {
    completed: gr.completed,
    interrupted: gr.interrupted?.node,
    outputs: Object.fromEntries(stageIds.map(id => [id, gr.state[id]])),
    degradedStages: stageIds.filter(id => gr.state[`${id}__degradation`] !== undefined).sort(),
    degradedCount: gr.degraded.length,
  };
}

/** 实测差异集：每项的**类型前缀**都必须是 `LINK_DIFFERENCES` 里的已登记类型（类型层把关）。 */
function diffLinks(manifest: WorkflowManifest, wf: LinkView, gr: LinkView): Diff[] {
  const diffs: Diff[] = [];
  if (wf.completed !== gr.completed) diffs.push("completion");
  for (const stage of manifest.stages) {
    if (JSON.stringify(wf.outputs[stage.id] ?? null) !== JSON.stringify(gr.outputs[stage.id] ?? null)) {
      diffs.push(`stage-output:${stage.id}`);
    }
  }
  // 阶段级降级集合或降级条数不同 ⇒ 两链路对"降级"的表达不同（粒度/通道差异）。
  if (
    JSON.stringify(wf.degradedStages) !== JSON.stringify(gr.degradedStages) ||
    wf.degradedCount !== gr.degradedCount
  ) {
    diffs.push("degradation-report");
  }
  return diffs.sort();
}

// ---------------------------------------------------------------------------
// 两条链路的运行辅助
// ---------------------------------------------------------------------------

type LinkRunOptions = {
  ctx?: Record<string, unknown>;
  /** manifest 路径的放行集合（stageId 粒度）。 */
  grants?: string[];
  /** 图路径的放行集合：模拟 HITL——每次在门处中断，命中集合则 grantApproval + 续跑。 */
  approvals?: string[];
  executor?: Executor;
  handlers?: StageHandlerRegistry;
  withProvider?: boolean;
};

type LinkRun = {
  manifest: WorkflowManifest;
  wf: WorkflowRunResult;
  gr: GraphRunResult;
  /** 图路径实际暂停过的门（按顺序）。 */
  gates: string[];
  /** 实测差异集（断言须与 `EXPECTED_DIFFS` 对应项逐条相等）。 */
  diffs: Diff[];
};

async function runLinks(manifest: WorkflowManifest, opts: LinkRunOptions = {}): Promise<LinkRun> {
  const ctx = opts.ctx ?? { input: "输入" };
  const handlers = opts.handlers ?? globalStageHandlerRegistry;
  const providerOpt = opts.withProvider === true ? provider : undefined;

  const wf = await runWorkflow(manifest, ctx, opts.executor, {
    handlers,
    atoms: globalAtomRegistry,
    ...(providerOpt !== undefined ? { provider: providerOpt } : {}),
    ...(opts.grants !== undefined ? { approvalGrants: opts.grants } : {}),
  });

  const graph = manifestToGraph(manifest, {
    handlers,
    atoms: globalAtomRegistry,
    ...(opts.executor !== undefined ? { executor: opts.executor } : {}),
    ...(providerOpt !== undefined ? { provider: providerOpt } : {}),
  });
  const store = new InMemoryCheckpointStore();
  const graphId = `link-${manifest.id}`;
  let out = await runGraphWithCheckpoints(graph, { ...ctx }, { store, graphId });

  const gates: string[] = [];
  const pending = [...(opts.approvals ?? [])];
  while (out.result.interrupted !== undefined) {
    const node = out.result.interrupted.node;
    gates.push(node);
    if (!pending.includes(node)) break;
    const granted = await grantApproval(store, out.checkpointId!);
    assert.ok(granted !== undefined, `检查点 ${out.checkpointId} 应存在`);
    out = await runGraphWithCheckpoints(graph, { ...ctx }, { store, graphId, resumeFrom: granted });
  }

  const wfView = manifestView(wf);
  const grView = graphView(
    out.result,
    manifest.stages.map(s => s.id),
  );
  // 中断点：两链路的中断建模字段名不同（图 interrupted.node / manifest interrupted.stageId），
  // 在视域里已归一为同一"暂停在哪道门"；此处**无豁免**——两链路必须在同一道门暂停。
  assert.equal(wfView.interrupted, grView.interrupted, "两链路中断点必须一致（不设豁免）");
  return {
    manifest,
    wf,
    gr: out.result,
    gates,
    diffs: diffLinks(manifest, wfView, grView),
  };
}

// ---------------------------------------------------------------------------
// 代表性 manifest
// ---------------------------------------------------------------------------

/** 线性三阶段（无门、无降级）：两链路必须逐字一致。 */
const linearManifest: WorkflowManifest = {
  id: "equiv_linear",
  name: "线性等价",
  caseType: "test",
  stages: [
    { id: "s1", strategy: "chain", description: "一" },
    { id: "s2", strategy: "chain", description: "二" },
    { id: "s3", strategy: "chain", description: "三" },
  ],
};

/** retry 信号回退（受控循环）：图路径的条件边 vs manifest 路径的重跑。 */
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

/** 单门放行：已批准审批门的两路径占位输出必须一致（#345 漂移修复的跨链路判据）。 */
const singleGateManifest: WorkflowManifest = {
  id: "equiv_grant",
  name: "放行等价",
  caseType: "test",
  stages: [
    {
      id: "extract_features",
      strategy: "chain",
      description: "提取",
      atom: "extract",
      params: { extraction_type: "提取技术特征", output_key: "features" },
    },
    { id: "gate", strategy: "chain", description: "审批门", atom: "approval-gate" },
    { id: "report", strategy: "chain", description: "报告" },
  ],
};

/** 双门：只批第一道 ⇒ 第二道绝不能被"顺带放行"（放行泄漏的判据；见 #358）。 */
const multiGateManifest: WorkflowManifest = {
  id: "equiv_multi_gate",
  name: "双门",
  caseType: "test",
  stages: [
    { id: "s1", strategy: "chain", description: "一" },
    { id: "gate1", strategy: "chain", description: "门一", atom: "approval-gate" },
    { id: "s2", strategy: "chain", description: "二" },
    { id: "gate2", strategy: "chain", description: "门二", atom: "approval-gate" },
    { id: "s3", strategy: "chain", description: "三" },
  ],
};

/** 无 handler 无 executor：两链路的"阶段未执行"通道差异（已登记）。 */
const noExecutableManifest: WorkflowManifest = {
  id: "no_executable",
  name: "无执行体阶段",
  caseType: "test",
  stages: [
    { id: "preprocess", strategy: "chain", description: "预处理" },
    { id: "report", strategy: "chain", description: "报告" },
  ],
};

/** extract 原子 handler 抛错：两链路的错误重试通道差异（已登记）。 */
const failingHandlers = new StageHandlerRegistry();
for (const h of globalStageHandlerRegistry.list()) failingHandlers.register(h);
failingHandlers.register({
  name: "extract",
  category: "extract",
  execute: async () => {
    throw new Error("LLM 不可用");
  },
});

const errorManifest: WorkflowManifest = {
  id: "equiv_error",
  name: "错误重试通道",
  caseType: "test",
  stages: [
    {
      id: "extract",
      strategy: "chain",
      description: "提取",
      atom: "extract",
      params: { extraction_type: "提取技术特征", output_key: "features" },
    },
    { id: "report", strategy: "chain", description: "报告" },
  ],
};

/** 原子内部降级（按输出键 `features__degradation`）：即"阶段无产出"时两链路的降级粒度差异。 */
const atomDegradationManifest: WorkflowManifest = {
  id: "atom_degraded",
  name: "原子内部降级",
  caseType: "test",
  stages: [
    {
      id: "extract_features",
      strategy: "chain",
      description: "提取",
      atom: "extract",
      params: { extraction_type: "提取技术特征", output_key: "features" },
    },
    { id: "report", strategy: "chain", description: "报告" },
  ],
};

// ---------------------------------------------------------------------------
// 用例表：期望的**实测差异集**（不是"允许的差异"，是"就是这些"）
// ---------------------------------------------------------------------------

/**
 * 每个用例的期望差异集。两个用途：
 * 1. 驱动该用例的断言（实测差异必须逐条相等——多一条少一条都转红）；
 * 2. 被末尾的覆盖断言用于证明「登记表 ↔ 用例表」两向一致（防僵尸条目/防未登记差异）。
 */
const EXPECTED_DIFFS = {
  linear: [],
  retry: [],
  singleGate: [],
  multiGate: [],
  disclosureGranted: [],
  disclosureInterrupted: [],
  noExecutable: ["completion"],
  handlerError: ["completion", "stage-output:extract"],
  atomDegradation: ["completion", "degradation-report"],
} as const satisfies Record<string, readonly Diff[]>;

// ---------------------------------------------------------------------------
// 用例：逐条独立（负控制时要求「红名单逐条可指回」+ 相邻用例仍绿）
// ---------------------------------------------------------------------------

test("[跨链路] 线性三阶段（executor）：产出逐阶段一致、完成态一致", async () => {
  const run = await runLinks(linearManifest, { executor: okExecutor });
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.linear]);
  assert.equal(run.wf.completed, true);
  assert.equal(run.gr.completed, true);
});

test("[跨链路] retry 信号回退：回退重跑后两链路产出一致", async () => {
  // 两路径独立计数器（共享闭包会互相消耗）。
  const wfExecutor = makeFlakyExecutor();
  const grExecutor = makeFlakyExecutor();
  // 完整 ctx（对齐 patent_workflow_run 的 workflowCtx 映射）：extract 原子需要这些键才不降级，
  // 否则本用例会混入"原子内部降级"通道差异（那由 atomDegradation 用例单独覆盖）。
  const retryCtx = { input: "一种装置", text: "一种装置", source_text: "一种装置", extraction_input: "一种装置" };
  const wf = await runWorkflow(retryManifest, retryCtx, wfExecutor.fn, {
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
  const gr = await graph.run({ ...retryCtx });

  assert.equal(wf.stages.find(s => s.stageId === "check")?.output, "一致");
  assert.equal(gr.state.check, "一致");
  assert.equal(wfExecutor.calls(), 2, "manifest 路径回退重跑 extract");
  assert.equal(grExecutor.calls(), 2, "图路径回退重跑 extract");
  const run = await runLinks(retryManifest, {
    ctx: retryCtx,
    executor: makeFlakyExecutor().fn,
    withProvider: true,
  });
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.retry]);
});

test("[跨链路] 单门放行（HITL：图路径中断→批准→续跑）：占位输出与产物一致", async () => {
  // 完整 ctx：本用例只考察"放行后的产物"，不混入原子内部降级（见 atomDegradation 用例）。
  const input = "一种自动化分拣装置，包含传送带、识别传感器与分拣机械臂";
  const run = await runLinks(singleGateManifest, {
    ctx: { input, text: input, source_text: input, extraction_input: input },
    executor: okExecutor,
    withProvider: true,
    grants: ["gate"],
    approvals: ["gate"],
  });
  assert.deepEqual(run.gates, ["gate"], "图路径在 gate 处暂停一次并被批准");
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.singleGate]);
  assert.equal(run.wf.stages.find(s => s.stageId === "gate")?.output, "APPROVED");
  assert.equal(run.gr.state.gate, "APPROVED", "图路径已放行审批门同样补占位输出");
  assert.deepEqual(run.wf.degradedSteps, [], "放行不是降级：manifest 路径不标 degraded");
  assert.deepEqual(run.gr.degraded, [], "放行不是降级：图路径无降级标记");
});

test("[跨链路] 双门只批第一道：第二道必须仍暂停（放行不得泄漏到后续门）", async () => {
  const run = await runLinks(multiGateManifest, {
    executor: okExecutor,
    grants: ["gate1"],
    approvals: ["gate1"],
  });

  // manifest 路径：只批 gate1 ⇒ 停在 gate2。
  assert.equal(run.wf.completed, false);
  assert.equal(run.wf.interrupted?.stageId, "gate2");
  assert.equal(run.wf.stages.find(s => s.stageId === "gate1")?.output, "APPROVED");
  assert.equal(run.wf.stages.find(s => s.stageId === "gate2")?.output, undefined, "gate2 未执行（未获批）");
  assert.equal(run.wf.stages.find(s => s.stageId === "s3")?.output, undefined, "gate2 之后的阶段未执行");

  // 图路径：同样只批 gate1 ⇒ 同样停在 gate2（放行记录按门 id，不含 gate2）。
  assert.deepEqual(run.gates, ["gate1", "gate2"], "图路径先后在 gate1、gate2 暂停");
  assert.equal(run.gr.completed, false, "批准 gate1 不得让整条链路跑完");
  assert.equal(run.gr.interrupted?.node, "gate2", "第二次中断必须仍是真实暂停");
  assert.equal(run.gr.state.gate1, "APPROVED");
  assert.equal(run.gr.state.gate2, undefined, "gate2 未被静默放行");
  assert.equal(run.gr.state.s3, undefined, "gate2 之后的阶段未执行");

  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.multiGate], "两链路在「只批一道门」下产出完全一致");
});

test("[跨链路] 手建域图：同一放行记录对两套节点工厂都生效（handlerNode 注册的门必须被解除）", async () => {
  // 本用例比对的是**两套节点工厂**——manifestToGraph 的 makeStageNode（按 stage.id 判定）
  // 与域图用的 domains/shared `handlerNode`（按节点名判定）——不是同一 manifest 的两条链路，
  // 故不用 runLinks：两工厂必须**完全等价**，不存在"有意差异"，差异登记表不适用。
  //
  // ⚠️ 域图的审批门一律带 params（如 `{ review_context: ... }`，见 domains/novelty.ts:202），
  // 执行态因此是拷贝、调用方**不会**再传 APPROVAL_GRANTED_KEY——放行标记只能由节点自己注入，
  // 缺了它 grantApproval 就形同虚设（门在 resume 时会再次中断）。
  const build = (graphId: string) => {
    const builder = new GraphBuilder();
    builder
      .addNode("prep", async () => ({ prep_done: true }))
      .addNode("gate", handlerNode(new ApprovalGateHandler(), { review_context: "需人工复核" }))
      .addNode("after", async () => ({ after_done: true }))
      .addEdge("prep", "gate")
      .addEdge("gate", "after");
    return { graph: builder.compile("prep"), graphId };
  };

  // ① 无放行：停在门。
  const g1 = build("hand-gate");
  const store1 = new InMemoryCheckpointStore();
  const first = await runGraphWithCheckpoints(g1.graph, {}, { store: store1, graphId: g1.graphId });
  assert.equal(first.result.completed, false);
  assert.equal(first.result.interrupted?.node, "gate");
  assert.ok(first.checkpointId);

  // ② 批准：同一放行记录（门 id 集合）必须解除 handlerNode 注册的门。
  const granted = await grantApproval(store1, first.checkpointId!);
  assert.ok(granted);
  assert.deepEqual(granted.state[APPROVAL_GRANTED_NODES_KEY], ["gate"], "放行记录 = 被批准的门节点 id");
  const resumed = await runGraphWithCheckpoints(
    g1.graph,
    {},
    {
      store: store1,
      graphId: g1.graphId,
      resumeFrom: granted,
    },
  );
  assert.equal(resumed.result.completed, true, "handlerNode 注册的门必须被放行记录解除");
  assert.equal(resumed.result.state.after_done, true, "门之后的节点执行");
  assert.equal(resumed.result.state[APPROVAL_GRANTED_KEY], undefined, "共享 state 不得残留全局放行布尔");

  // ③ 门粒度：放行记录不含该门名 ⇒ 不得放行（fail-closed）。
  const g2 = build("hand-gate-wrong");
  const store2 = new InMemoryCheckpointStore();
  const paused = await runGraphWithCheckpoints(g2.graph, {}, { store: store2, graphId: g2.graphId });
  assert.equal(paused.result.interrupted?.node, "gate");
  const wrongCp = await store2.loadLatest(g2.graphId);
  assert.ok(wrongCp);
  wrongCp.state[APPROVAL_GRANTED_NODES_KEY] = ["other-gate"];
  const stillPaused = await runGraphWithCheckpoints(
    g2.graph,
    {},
    {
      store: store2,
      graphId: g2.graphId,
      resumeFrom: wrongCp,
    },
  );
  assert.equal(stillPaused.result.completed, false, "放行记录不含该门名 ⇒ 不得静默放行");
  assert.equal(stillPaused.result.interrupted?.node, "gate");
  assert.equal(stillPaused.result.state.after_done, undefined, "门之后的节点未执行");
});

test("[跨链路] patentDisclosureManifest 全流程（放行审批门）：产出逐阶段一致", async () => {
  // 对齐 patent_workflow_run 的 workflowCtx 映射：input/text/source_text/extraction_input 同一份输入。
  const input = "一种自动化分拣装置，包含传送带、识别传感器与分拣机械臂";
  const run = await runLinks(patentDisclosureManifest, {
    ctx: { input, text: input, source_text: input, extraction_input: input },
    withProvider: true,
    executor: async stage => (stage.id === "report" ? "披露分析报告：方案具备创新点与保护建议" : `[${stage.id}] 完成`),
    grants: ["review_gate"],
    approvals: ["review_gate"],
  });

  assert.deepEqual(run.gates, ["review_gate"], "图路径在 review_gate 处暂停并被批准");
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.disclosureGranted]);
  assert.equal(run.wf.completed, true);
  assert.equal(run.gr.completed, true);
  assert.equal(run.wf.stages.find(s => s.stageId === "review_gate")?.output, "APPROVED");
  assert.equal(run.gr.state.review_gate, "APPROVED");
  // 放行不是降级：两条链路的降级通道都为空。
  assert.deepEqual(run.wf.degradedSteps, []);
  assert.deepEqual(run.gr.degraded, []);
});

test("[跨链路] patentDisclosureManifest 未放行：两链路在同一道门暂停，且此前阶段产出一致", async () => {
  const input = "一种自动化分拣装置";
  const run = await runLinks(patentDisclosureManifest, {
    ctx: { input, text: input, source_text: input, extraction_input: input },
    withProvider: true,
    executor: async stage => (stage.id === "report" ? "报告" : `[${stage.id}] 完成`),
  });

  assert.deepEqual(run.gates, ["review_gate"], "图路径在 review_gate 处暂停一次（未获批）");
  assert.equal(run.wf.completed, false);
  assert.equal(run.gr.completed, false);
  assert.equal(run.wf.interrupted?.stageId, "review_gate");
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.disclosureInterrupted]);
});

test("[跨链路] 无可执行体阶段：仅降级通道（+其伴生完成态）有差异，阶段文本一致", async () => {
  const run = await runLinks(noExecutableManifest);
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.noExecutable]);
  // 差异只在通道上：两链路的阶段输出文本一致（均为空输出）。
  for (const stage of noExecutableManifest.stages) {
    assert.equal(run.gr.state[stage.id], run.wf.stages.find(s => s.stageId === stage.id)?.output);
  }
  // manifest 路径：空输出进 degradedSteps 且 completed=false；图路径：state 级降级标记，completed 不受影响。
  assert.equal(run.wf.completed, false);
  assert.deepEqual(run.gr.state.preprocess__degraded, undefined, "旧死键不再写入（#345）");
  assert.equal(run.gr.completed, true);
  assert.equal(run.gr.degraded.length, run.wf.degradedSteps.length, "降级阶段数一致，只是通道不同");
});

test("[跨链路] handler 抛错：错误重试通道差异（retry 文本 vs 节点级降级标记）", async () => {
  const run = await runLinks(errorManifest, { handlers: failingHandlers, executor: okExecutor });
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.handlerError]);
  // manifest 路径：重试后把错误写进阶段输出文本，并计入 degradedSteps。
  assert.match(String(run.wf.stages.find(s => s.stageId === "extract")?.output), /^\[WORKFLOW_DEGRADED\]/);
  assert.deepEqual(run.wf.degradedSteps, ["extract"]);
  // 图路径：不重试、不留输出文本，降级只体现为节点级标记（reason=node_failed）。
  assert.equal(run.gr.state.extract, undefined);
  assert.deepEqual(
    run.gr.degraded.map(m => m.reason),
    ["node_failed"],
  );
});

test("[跨链路] 原子内部降级：manifest 路径计入 degradedSteps，图路径只有键级标记", async () => {
  // ctx 缺 extract 原子所需输入 ⇒ LLM 阶段无输出 ⇒ 两链路对"这一阶段降级了吗"的表达不同：
  // manifest 路径按阶段记 degradedSteps；图路径的阶段级降级键不存在（降级落在输出键上）。
  const run = await runLinks(atomDegradationManifest, { executor: okExecutor, withProvider: true });
  assert.deepEqual(run.diffs, [...EXPECTED_DIFFS.atomDegradation]);
  assert.deepEqual(run.wf.degradedSteps, ["extract_features"], "manifest 路径按阶段记降级");
  assert.equal(run.gr.state.extract_features__degradation, undefined, "图路径无该阶段的阶段级降级键");
  assert.equal(run.wf.completed, false, "manifest 路径：阶段降级 ⇒ completed=false");
  assert.equal(run.gr.completed, true, "图路径 completed 不受降级影响（已登记差异）");
});

test("[跨链路] 差异登记表与用例表两向一致（无僵尸条目、无未登记类型）", () => {
  const registered = Object.keys(LINK_DIFFERENCES).sort();
  const exercised = [
    ...new Set(
      Object.values(EXPECTED_DIFFS)
        .flat()
        .map(d => d.split(":")[0]),
    ),
  ].sort();
  assert.deepEqual(exercised, registered, "登记表每条差异必须有用例实证；用例不得引入未登记类型");
});
