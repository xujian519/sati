import assert from "node:assert/strict";
import test from "node:test";
import { InvalidityAnalysisHandler } from "../../src/patent/atoms/handlers/builtin/invalidity.js";
import { buildInventivenessGraph, buildNoveltyGraph } from "../../src/patent/graph/domains/index.js";
import { registerBuiltinAtoms } from "../../src/patent/atoms/index.js";
import type { StageProvider } from "../../src/patent/atoms/index.js";

registerBuiltinAtoms();

function chart(targets: Array<{ id: string; title?: string }>, quotes = true): string {
  return JSON.stringify({
    claim: "1. 一种装置，包括壳体。",
    elements: [{ id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" }],
    targets: targets.map(target => ({ ...target, kind: "prior-art" })),
    rows: targets.flatMap(target =>
      quotes
        ? [
            {
              elementId: "1a",
              targetId: target.id,
              quote: "壳体",
              pinCite: `[${target.id} 段[0010]]`,
              mapping: "literal",
            },
          ]
        : [],
    ),
    gaps: [],
  });
}

const provider: StageProvider = {
  callLLM: async prompt => {
    if (prompt.includes("提取")) return JSON.stringify({ features: ["壳体"] });
    if (prompt.includes("对比范围")) {
      return JSON.stringify({
        claim_chart: [{ feature: "壳体", prior_art_match: "D1", identical: true }],
        diff_features: [],
      });
    }
    return "新颖性分析报告";
  },
  search: async () => {
    throw new Error("证据模式不应调用检索");
  },
};

test("证据为空：不编译图、不检索，主输出写明拒绝自行检索", async () => {
  let searches = 0;
  const handler = new InvalidityAnalysisHandler();
  const result = await handler.execute({
    state: { claim_chart_doc: chart([]), analysis: "novelty", text: "一种装置" },
    provider: {
      callLLM: provider.callLLM,
      search: async () => {
        searches += 1;
        return [];
      },
    },
  });
  const report = JSON.parse(result.invalidity_report as string) as {
    status: string;
    reason: string;
    nodes: string[];
  };
  assert.equal(report.status, "degraded_no_evidence");
  assert.equal(report.reason.includes("拒绝改为自行检索"), true);
  assert.deepEqual(report.nodes, []);
  assert.equal(searches, 0);
});

test("有证据：执行轨迹不含 search，文献 id 等于对照表目标 id", async () => {
  const handler = new InvalidityAnalysisHandler();
  const result = await handler.execute({
    state: { claim_chart_doc: chart([{ id: "D1", title: "对比文件1" }]), analysis: "novelty", text: "一种装置" },
    provider,
  });
  const report = JSON.parse(result.invalidity_report as string) as {
    analysis: string;
    targetIds: string[];
    nodes: string[];
  };
  assert.equal(report.analysis, "novelty");
  assert.deepEqual(report.targetIds, ["D1"]);
  assert.equal(report.nodes.includes("search"), false);
});

test("有目标但没有引文：仍执行对比，并标记证据不足", async () => {
  const handler = new InvalidityAnalysisHandler();
  const result = await handler.execute({
    state: { claim_chart_doc: chart([{ id: "D1" }], false), analysis: "novelty", text: "一种装置" },
    provider,
  });
  const report = JSON.parse(result.invalidity_report as string) as { evidenceWithoutQuote: string[] };
  assert.deepEqual(report.evidenceWithoutQuote, ["D1"]);
});

test("图构建：supplied 不注册 search 节点，缺省仍按 handler 注册检索", () => {
  const supplied = buildNoveltyGraph({ evidence: "supplied" }).compile("extract").describe();
  assert.equal(supplied.nodes.includes("search"), false);
  assert.equal(supplied.nodes.includes("keywords"), false);

  const searchy = buildNoveltyGraph().compile("extract").describe();
  assert.equal(searchy.nodes.includes("search"), true);
});

test("创造性图：supplied 不注册检索链，缺省保留", () => {
  const supplied = buildInventivenessGraph({ evidence: "supplied" }).compile("parse").describe();
  for (const node of ["search", "prepare_query", "recall_check", "refine_query", "converge_prior_art", "build_query"]) {
    assert.equal(supplied.nodes.includes(node), false, `${node} 不应出现在证据模式`);
  }
  const edges = new Set(supplied.edges.flatMap(([from, targets]) => targets.map(to => `${from}→${to}`)));
  assert.ok(edges.has("domain_inject→closest"), "证据模式应从领域注入直连 closest");

  const searchy = buildInventivenessGraph().compile("parse").describe();
  assert.equal(searchy.nodes.includes("search"), true);
  assert.equal(searchy.nodes.includes("recall_check"), true);
  assert.equal(searchy.nodes.includes("build_query"), true);
});

test("有证据：分析使用 state.claim，而不是整份无效请求", async () => {
  let extractPrompt = "";
  const captureProvider: StageProvider = {
    callLLM: async prompt => {
      if (prompt.includes("提取")) {
        extractPrompt = prompt;
        return JSON.stringify({ features: ["壳体"] });
      }
      if (prompt.includes("对比范围")) {
        return JSON.stringify({
          claim_chart: [{ feature: "壳体", prior_art_match: "D1", identical: true }],
          diff_features: [],
        });
      }
      return "新颖性分析报告";
    },
  };
  const result = await new InvalidityAnalysisHandler().execute({
    state: {
      claim_chart_doc: chart([{ id: "D1" }]),
      analysis: "novelty",
      claim: "1. 一种装置，包括壳体。",
      text: "这是一整份无效宣告请求书，包含请求人陈述与证据说明。",
    },
    provider: captureProvider,
  });
  assert.ok(extractPrompt.includes("1. 一种装置，包括壳体。"));
  assert.equal(extractPrompt.includes("整份无效宣告请求书"), false);
  assert.equal(JSON.parse(result.invalidity_report as string).status, "completed");
});
