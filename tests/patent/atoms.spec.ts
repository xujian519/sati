import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_GRANTED_KEY,
  AtomRegistry,
  AtomRegistryError,
  InterruptStageError,
  LookupStageHandler,
  StageHandlerRegistry,
  WorkflowError,
  evidenceCoverage,
  isApprovalGateHandler,
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

test("registerBuiltinAtoms 注册 10 个内置原子与 handler", () => {
  registerBuiltinAtoms();
  const names = ListAtoms()
    .map(a => a.name)
    .sort();
  assert.deepEqual(names, [
    "approval-gate",
    "compare",
    "draft-claims",
    "extract",
    "groundedness",
    "keywords",
    "merge",
    "novelty",
    "reasoning",
    "search",
  ]);
  for (const name of names) {
    assert.ok(LookupStageHandler(name), `handler ${name} 已注册`);
  }
  assert.equal(globalAtomRegistry.list().length >= 10, true);
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

test("ApprovalGateHandler：state 含放行标记时直接放行（不中断）", async () => {
  const h = LookupStageHandler("approval-gate")!;
  const out = await h.execute({
    state: { review_context: "请人工确认", [APPROVAL_GRANTED_KEY]: { 1720000000000: true } },
  });
  assert.deepEqual(out, {});
});

test("isApprovalGateHandler：按 name 契约识别审批门", () => {
  const gate = LookupStageHandler("approval-gate")!;
  assert.equal(isApprovalGateHandler(gate), true);
  const extract = LookupStageHandler("extract")!;
  assert.equal(isApprovalGateHandler(extract), false);
});

// ---------------------------------------------------------------------------
// groundedness / keywords / novelty（disclosure 管线补全）
// ---------------------------------------------------------------------------

const groundednessProvider: StageProvider = {
  callLLM: async prompt => {
    if (prompt.includes("打分规则")) {
      return JSON.stringify({
        scores: [
          { feature: "散热鳍片", score: 0.95, reason: "原文第3段明确记载" },
          { feature: "AI 自适应", score: 0.3, reason: "原文未记载，仅推断" },
        ],
        feedback: "散热鳍片依据充分；AI 自适应需补充原文支持",
      });
    }
    if (prompt.includes("检索关键词")) {
      return JSON.stringify({ keywords: ["散热鳍片", "散热结构", "换热器"] });
    }
    if (prompt.includes("对比范围")) {
      return JSON.stringify({
        assessments: [
          { feature: "散热鳍片", prior_art: "D1", disclosed: true, reasoning: "D1 公开相同结构" },
          { feature: "AI 自适应", prior_art: "", disclosed: false, reasoning: "D1-D3 均未公开" },
        ],
        conclusion: "区别特征为 AI 自适应，具备新颖性（置信度 high）",
      });
    }
    return "推理结论";
  },
};

test("GroundednessHandler：批量打分并汇总低分特征", async () => {
  const h = LookupStageHandler("groundedness")!;
  const out = await h.execute({
    state: { features: ["散热鳍片", "AI 自适应"], source_text: "本发明通过散热鳍片提升散热效率。" },
    provider: groundednessProvider,
  });
  assert.deepEqual(out.low_confidence_features, ["AI 自适应"]);
  assert.match(String(out.groundedness_feedback), /低依据特征 1 个/);
  assert.match(String(out.groundedness_result), /0\.3/);
});

test("GroundednessHandler：无特征跳过；无 LLM 降级；LLM 失败 fail-open", async () => {
  const h = LookupStageHandler("groundedness")!;
  const empty = await h.execute({ state: { features: [], source_text: "x" }, provider: groundednessProvider });
  assert.match(String(empty.groundedness_result), /skipped/);
  const noLlm = await h.execute({ state: { features: ["F1"], source_text: "x" }, provider: {} });
  assert.match(String(noLlm._error), /未配置 LLM/);
  const failing: StageProvider = {
    callLLM: async () => {
      throw new Error("timeout");
    },
  };
  const failOpen = await h.execute({ state: { features: ["F1"], source_text: "x" }, provider: failing });
  assert.match(String(failOpen.groundedness_result), /skipped/);
  assert.match(String(failOpen.groundedness_feedback), /LLM 调用失败/);
});

test("KeywordsHandler：生成检索关键词写入 keywords 键", async () => {
  const h = LookupStageHandler("keywords")!;
  const out = await h.execute({ state: { extraction_result: "散热鳍片结构" }, provider: groundednessProvider });
  assert.deepEqual(out.keywords, ["散热鳍片", "散热结构", "换热器"]);
});

test("KeywordsHandler：无 LLM 或输入为空时降级", async () => {
  const h = LookupStageHandler("keywords")!;
  const noLlm = await h.execute({ state: { extraction_result: "x" }, provider: {} });
  assert.match(String(noLlm._error), /未配置 LLM/);
  const emptyInput = await h.execute({ state: {}, provider: groundednessProvider });
  assert.match(String(emptyInput._error), /输入为空/);
});

test("NoveltyHandler：结合 prior_art 逐特征判定并标注证据覆盖", async () => {
  const h = LookupStageHandler("novelty")!;
  const out = await h.execute({
    state: {
      features: ["散热鳍片", "AI 自适应"],
      prior_art: [
        { title: "D1", snippet: "公开散热鳍片结构" },
        { title: "D2", snippet: "公开换热器" },
        { title: "D3", snippet: "公开散热材料" },
      ],
    },
    provider: groundednessProvider,
  });
  assert.equal(out.evidence_coverage, "full");
  assert.match(String(out.novelty_conclusion), /具备新颖性/);
  assert.match(String(out.novelty_result), /AI 自适应/);
});

test("NoveltyHandler：无证据降级为 none；无 LLM 降级", async () => {
  const h = LookupStageHandler("novelty")!;
  const noEvidence = await h.execute({
    state: { features: ["F1"], prior_art: [] },
    provider: groundednessProvider,
  });
  assert.equal(noEvidence.evidence_coverage, "none");
  const noLlm = await h.execute({ state: { features: ["F1"] }, provider: {} });
  assert.match(String(noLlm._error), /未配置 LLM/);
  const noFeatures = await h.execute({ state: { prior_art: [] }, provider: groundednessProvider });
  assert.match(String(noFeatures._error), /无特征可评估/);
});

test("evidenceCoverage 分级：0→none / 1-2→partial / ≥3→full", () => {
  assert.equal(evidenceCoverage(0), "none");
  assert.equal(evidenceCoverage(1), "partial");
  assert.equal(evidenceCoverage(2), "partial");
  assert.equal(evidenceCoverage(3), "full");
});

// ---------------------------------------------------------------------------
// extract 分键 / merge / draft-claims（① 修复三路覆盖 + ② 直出草稿）
// ---------------------------------------------------------------------------

test("ExtractHandler：output_key 分键——只写对应键，互不覆盖", async () => {
  const h = LookupStageHandler("extract")!;
  const problems = await h.execute({ state: { text: "x", output_key: "problems" }, provider });
  assert.deepEqual(problems.problems, ["问题1"]);
  assert.equal(problems.features, undefined, "problems 提取不应写 features");
  const features = await h.execute({ state: { text: "x", output_key: "features" }, provider });
  assert.deepEqual(features.features, ["特征A", "特征B"]);
  assert.equal(features.problems, undefined, "features 提取不应写 problems");
  const effects = await h.execute({ state: { text: "x", output_key: "effects" }, provider });
  assert.deepEqual(effects.effects, []);
  assert.equal(effects.features, undefined, "effects 提取不应写 features");
});

test("ExtractHandler：无 output_key 保持旧行为（全量写）", async () => {
  const h = LookupStageHandler("extract")!;
  const out = await h.execute({ state: { text: "x" }, provider });
  assert.deepEqual(out.features, ["特征A", "特征B"]);
  assert.deepEqual(out.problems, ["问题1"]);
  assert.deepEqual(out.effects, []);
});

test("MergeHandler：PFE 按索引配对为三元组", async () => {
  const h = LookupStageHandler("merge")!;
  const out = await h.execute({
    state: { problems: ["问题1", "问题2"], features: ["特征A", "特征B"], effects: ["效果1", "效果2"] },
  });
  const triples = out.pfe_triples as Array<{ id: string; problem: string; features: string[]; effects: string[] }>;
  assert.equal(triples.length, 2);
  assert.equal(triples[0]!.problem, "问题1");
  assert.deepEqual(triples[0]!.features, ["特征A"]);
  assert.deepEqual(triples[0]!.effects, ["效果1"]);
  assert.equal(triples[1]!.id, "T2");
  assert.match(String(out.merge_result), /2 个问题 \/ 2 个特征 \/ 2 个效果/);
});

test("MergeHandler：多余特征并入末组；无问题时构造单一三元组", async () => {
  const h = LookupStageHandler("merge")!;
  const extra = await h.execute({ state: { problems: ["P1"], features: ["F1", "F2"], effects: [] } });
  const triples = extra.pfe_triples as Array<{ features: string[] }>;
  assert.deepEqual(triples[0]!.features, ["F1", "F2"]);
  const noProblem = await h.execute({ state: { problems: [], features: ["F1"], effects: ["E1"] } });
  const single = noProblem.pfe_triples as Array<{ problem: string; features: string[] }>;
  assert.equal(single.length, 1);
  assert.equal(single[0]!.problem, "");
  assert.deepEqual(single[0]!.features, ["F1"]);
});

test("MergeHandler：三路全空时降级（不抛错）", async () => {
  const h = LookupStageHandler("merge")!;
  const out = await h.execute({ state: {} });
  assert.match(String(out._error), /三路提取结果均为空/);
});

const claimsProvider: StageProvider = {
  callLLM: async () =>
    JSON.stringify({
      claims: ["1. 一种散热装置，包括散热鳍片…", "2. 根据权利要求1所述的散热装置，其特征是…"],
      notes: "独立权利要求含必要技术特征",
    }),
};

test("DraftClaimsHandler：产出权利要求草稿（逐条拼接）", async () => {
  const h = LookupStageHandler("draft-claims")!;
  const out = await h.execute({
    state: { merge_result: "PFE 融合：1 个问题 / 1 个特征 / 1 个效果", novelty_conclusion: "具备新颖性" },
    provider: claimsProvider,
  });
  assert.match(String(out.claims_draft), /^1\. 一种散热装置/);
  assert.match(String(out.claims_draft), /\n\n2\. /);
});

test("DraftClaimsHandler：无 LLM 或输入为空时降级", async () => {
  const h = LookupStageHandler("draft-claims")!;
  const noLlm = await h.execute({ state: { merge_result: "x" }, provider: {} });
  assert.match(String(noLlm._error), /未配置 LLM/);
  const empty = await h.execute({ state: {}, provider: claimsProvider });
  assert.match(String(empty._error), /输入为空/);
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
