import assert from "node:assert/strict";
import test from "node:test";
import {
  AtomRegistry,
  AtomRegistryError,
  InterruptStageError,
  LookupStageHandler,
  StageHandlerRegistry,
  WorkflowError,
  isInterruptStageError,
  patentNoveltyManifest,
  registerBuiltinAtoms,
  runWorkflow,
  searchAtom,
  type StageHandler,
  type StageProvider,
  type WorkflowManifest,
} from "../../src/patent/index.js";
import { ListAtoms, globalAtomRegistry } from "../../src/patent/atoms/atom.js";

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test("AtomRegistry 注册/查询/同名覆盖/分类列表", () => {
  const reg = new AtomRegistry();
  reg.register(searchAtom);
  assert.equal(reg.lookup("search")?.category, "search");
  assert.deepEqual(
    reg.listByCategory("search").map(a => a.name),
    ["search"],
  );

  // 同名覆盖（对齐 Mady 覆盖语义）
  reg.register({ name: "search", description: "覆盖版", category: "search", inputSchema: [], outputSchema: [] });
  assert.equal(reg.lookup("search")?.description, "覆盖版");

  // 缺少 name 抛错
  assert.throws(
    () => reg.register({ name: "", description: "x", category: "search", inputSchema: [], outputSchema: [] }),
    AtomRegistryError,
  );
});

test("StageHandlerRegistry 注册/查询/同名覆盖", () => {
  const reg = new StageHandlerRegistry();
  const h: StageHandler = { name: "t", category: "search", execute: async () => ({ ok: "1" }) };
  reg.register(h);
  assert.equal(reg.lookup("t"), h);
  const h2: StageHandler = { name: "t", category: "search", execute: async () => ({ ok: "2" }) };
  reg.register(h2);
  assert.equal(reg.lookup("t"), h2);
});

test("registerBuiltinAtoms 注册 5 个内置原子与 handler", () => {
  registerBuiltinAtoms();
  const names = ListAtoms()
    .map(a => a.name)
    .sort();
  assert.deepEqual(names, ["approval-gate", "compare", "extract", "reasoning", "search"]);
  for (const name of names) {
    assert.ok(LookupStageHandler(name), `handler ${name} 已注册`);
  }
  assert.equal(globalAtomRegistry.list().length >= 5, true);
});

// ---------------------------------------------------------------------------
// 内置 handler 行为
// ---------------------------------------------------------------------------

const provider: StageProvider = {
  callLLM: async prompt => {
    if (prompt.includes("提取")) {
      return JSON.stringify({ features: ["特征A", "特征B"], problems: ["问题1"], effects: [] });
    }
    if (prompt.includes("对比范围")) {
      return JSON.stringify({
        claim_chart: [{ feature: "F1", prior_art_match: "", identical: false }],
        diff_features: ["F1"],
      });
    }
    return "推理结论";
  },
  search: async query => [{ title: `文献: ${query}`, snippet: "摘要", url: "https://example.com/1" }],
};

test("SearchHandler：有 provider 产出 prior_art 与 search_summary", async () => {
  const h = LookupStageHandler("search")!;
  const out = await h.execute({ state: { query: "分拣装置", max_results: "3" }, provider });
  assert.ok(Array.isArray(out.prior_art));
  assert.equal(out.prior_art?.length, 1);
  assert.match(String(out.search_summary), /检索到 1 篇/);
});

test("SearchHandler：无 provider 或空查询时降级返回 _error（不抛错）", async () => {
  const h = LookupStageHandler("search")!;
  const noProvider = await h.execute({ state: { query: "x" }, provider: {} });
  assert.match(String(noProvider._error), /未配置检索器/);
  const emptyQuery = await h.execute({ state: {}, provider });
  assert.match(String(emptyQuery._error), /查询条件为空/);
});

test("ExtractHandler：JSON 输出回填 features/problems/effects", async () => {
  const h = LookupStageHandler("extract")!;
  const out = await h.execute({ state: { text: "一种自动化分拣装置", extraction_type: "技术特征抽取" }, provider });
  assert.deepEqual(out.features, ["特征A", "特征B"]);
  assert.deepEqual(out.problems, ["问题1"]);
  assert.ok(String(out.extraction_result).includes("特征A"));
});

test("ExtractHandler：LLM 输出非 JSON 时保留原文（不中断）", async () => {
  const h = LookupStageHandler("extract")!;
  const badProvider: StageProvider = { callLLM: async () => "这不是 JSON" };
  const out = await h.execute({ state: { text: "x" }, provider: badProvider });
  assert.equal(out.extraction_result, "这不是 JSON");
  assert.equal(out.features, undefined);
});

test("CompareHandler：产出 claim_chart 与 diff_features", async () => {
  const h = LookupStageHandler("compare")!;
  const out = await h.execute({
    state: { claim: "特征 F1", prior_art: [{ title: "D1", snippet: "含 F1" }] },
    provider,
  });
  assert.ok(Array.isArray(out.claim_chart));
  assert.equal(out.claim_chart?.length, 1);
  assert.deepEqual(out.diff_features, ["F1"]);
});

test("ReasoningHandler：无显式输入时拼接状态为上下文", async () => {
  const h = LookupStageHandler("reasoning")!;
  const out = await h.execute({ state: { claim_chart: "对比表", conclusion_ctx: "上文" }, provider });
  assert.equal(out.conclusion, "推理结论");
  assert.equal(out.reasoning_output, "推理结论");
});

test("ApprovalGateHandler：抛 InterruptStageError（不返回）", async () => {
  const h = LookupStageHandler("approval-gate")!;
  await assert.rejects(
    () => h.execute({ state: { review_context: "请人工确认新颖性结论" } }),
    err => {
      assert.ok(isInterruptStageError(err));
      assert.equal((err as InterruptStageError).stageId, "approval-gate");
      assert.equal((err as InterruptStageError).data.guardrail_level, "high");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// runWorkflow + 原子执行
// ---------------------------------------------------------------------------

test("runWorkflow 按 atom 分发执行并合并状态", async () => {
  const manifest: WorkflowManifest = {
    id: "atom_wf",
    name: "原子工作流",
    caseType: "test",
    stages: [
      { id: "search", strategy: "react", atom: "search", description: "检索" },
      { id: "conclude", strategy: "chain", atom: "reasoning", description: "结论" },
    ],
  };
  const result = await runWorkflow(manifest, { query: "分拣装置" }, undefined, { provider });
  assert.equal(result.completed, true);
  assert.equal(result.stages[0].output.includes("检索到 1 篇"), true);
  // search 输出已合并进 state，conclude（reasoning）可读取
  assert.equal(result.stages[1].output, "推理结论");
  assert.equal(result.stages[0].atom, "search");
});

test("runWorkflow 审批门阶段 → 返回 interrupted（暂停而非失败）", async () => {
  const manifest: WorkflowManifest = {
    id: "gate_wf",
    name: "审批工作流",
    caseType: "test",
    stages: [
      { id: "s1", strategy: "chain", atom: "reasoning", description: "分析" },
      { id: "approval", strategy: "chain", atom: "approval-gate", description: "人工确认" },
      { id: "s2", strategy: "chain", atom: "reasoning", description: "后续（不应执行）" },
    ],
  };
  const result = await runWorkflow(manifest, {}, undefined, { provider });
  assert.ok(result.interrupted, "应包含 interrupted 信息");
  assert.equal(result.interrupted?.stageId, "approval");
  assert.equal(result.completed, false);
  // 中断后不执行后续阶段
  assert.equal(result.stages.length, 1);
  assert.match(result.summary, /暂停等待人工确认/);
});

test("runWorkflow 声明未注册 atom → fail-fast 抛 WorkflowError", async () => {
  const manifest: WorkflowManifest = {
    id: "bad_atom",
    name: "未知原子",
    caseType: "test",
    stages: [{ id: "s1", strategy: "chain", atom: "no-such-atom", description: "x" }],
  };
  await assert.rejects(() => runWorkflow(manifest, {}, undefined, { provider }), WorkflowError);
});

test("runWorkflow 向后兼容：executor 可选、无 atom 时走 executor", async () => {
  // 不传 executor 且无 atom → 输出为空 → degraded
  const manifest: WorkflowManifest = {
    id: "plain_wf",
    name: "纯收口",
    caseType: "test",
    validation: { requireAllSteps: false },
    stages: [{ id: "s1", strategy: "chain", description: "x" }],
  };
  const result = await runWorkflow(manifest, {});
  assert.equal(result.stages[0].degraded, true);
  assert.equal(result.completed, true); // requireAllSteps=false
});

test("patentNoveltyManifest 纯收口语义（无 atom 声明）", () => {
  assert.deepEqual(
    patentNoveltyManifest.stages.map(s => s.strategy),
    ["chain", "react", "chain", "chain", "chain"],
  );
  // 内置 manifest 不声明 atom：消费方 patent_workflow 工具为"主代理产出→工具收口"语义。
  assert.deepEqual(
    patentNoveltyManifest.stages.map(s => s.atom),
    [undefined, undefined, undefined, undefined, undefined],
  );
});
