import assert from "node:assert/strict";
import test from "node:test";
import {
  createPatentKgQueryTool,
  type PatentKgAdapterRef,
  type PatentKgQueryOutput,
} from "../../../src/tool/builtin/patentKgQuery.js";
import type { PatentKgAdapter } from "../../../src/knowledge/patent/patent-kg-adapter.js";
import type { KgNode } from "../../../src/knowledge/patent/types.js";

/** 构造图谱访问 mock（不触碰真实 patent_kg.db，CI 可跑）。 */
function makeRef(): PatentKgAdapterRef {
  const nodes: Record<string, KgNode> = {
    CASE_005: { id: "CASE_005", nodeType: "Case", title: "医疗器械产品权利要求的用途特征", content: "case-content" },
    JUDG_1: { id: "JUDG_1", nodeType: "SupremeCourtJudgment", title: "最高法判决一" },
    JUDG_2: { id: "JUDG_2", nodeType: "RegionalCourtJudgment", title: "地方法院判决二" },
    RULE_1: {
      id: "RULE_1",
      nodeType: "GuidelineRule",
      name: "三步法",
      title: "创造性判断规则",
      content: "rule-content",
    },
    CLAUSE_1: { id: "CLAUSE_1", nodeType: "Clause", title: "专利法第22条第3款" },
    WIKI_1: { id: "WIKI_1", nodeType: "WikiCard", title: "Bolar例外卡片" },
  };

  const adapter = {
    getNode: (id: string) => nodes[id],
    searchRelevant: (_query: string) => [
      { node: nodes.RULE_1, via: "keyword" },
      { node: nodes.CASE_005, via: "similar", relation: "SIMILAR_TO" },
      { node: nodes.JUDG_1, via: "cites", relation: "CITES" },
    ],
    getSimilarNodes: (_id: string) => [{ node: nodes.WIKI_1, relation: "RELATED_TO" }],
    getNeighbors: (_id: string, relation: string) =>
      relation === "CITES" ? [{ targetId: "JUDG_1", relation: "CITES" }] : [],
    listByType: (type: string) =>
      type === "SupremeCourtJudgment" ? [nodes.JUDG_1] : type === "RegionalCourtJudgment" ? [nodes.JUDG_2] : [],
  } as unknown as PatentKgAdapter;

  return { adapter, dbPath: "/mock/patent_kg.db" };
}

function asJson(
  result: Awaited<ReturnType<ReturnType<typeof createPatentKgQueryTool>["execute"]>>,
): PatentKgQueryOutput {
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  return first.value as PatentKgQueryOutput;
}

test("patent_kg_query: 工具元数据正确", () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  assert.equal(tool.name, "patent_kg_query");
  assert.equal(tool.domain, "patent");
  assert.equal(tool.isReadOnly({ query: "x" }), true);
  assert.equal(tool.isConcurrencySafe({ query: "x" }), true);
});

test("patent_kg_query: 关键词模式返回 via/relation 标注", async () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  const result = await tool.execute({ query: "三步法", limit: 5 }, {} as never);
  const output = asJson(result);
  assert.equal(output.total, 3);
  const byId = new Map(output.hits.map(hit => [hit.id, hit]));
  assert.equal(byId.get("RULE_1")?.via, "keyword");
  assert.equal(byId.get("CASE_005")?.via, "similar");
  assert.equal(byId.get("CASE_005")?.relation, "SIMILAR_TO");
  assert.equal(byId.get("JUDG_1")?.via, "cites");
  assert.equal(byId.get("JUDG_1")?.relation, "CITES");
});

test("patent_kg_query: expand=false 仅返回关键词命中", async () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  const result = await tool.execute({ query: "三步法", expand: false }, {} as never);
  const output = asJson(result);
  assert.equal(output.total, 1);
  assert.equal(output.hits[0]?.via, "keyword");
});

test("patent_kg_query: id 模式返回详情与相似/引用邻居", async () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  const result = await tool.execute({ id: "CASE_005" }, {} as never);
  const output = asJson(result);
  assert.equal(output.total, 1);
  const hit = output.hits[0];
  assert.equal(hit?.id, "CASE_005");
  assert.ok(hit?.neighbors, "id 模式应返回邻居");
  const relations = new Set(hit.neighbors!.map(neighbor => neighbor.relation));
  assert.ok(relations.has("RELATED_TO"), "应含相似邻居");
  assert.ok(relations.has("CITES"), "应含引用邻居");
});

test("patent_kg_query: id 不存在返回空结果", async () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  const result = await tool.execute({ id: "NOT_EXIST" }, {} as never);
  const output = asJson(result);
  assert.equal(output.total, 0);
  assert.deepEqual(output.hits, []);
});

test("patent_kg_query: node_type Judgment 别名展开合并", async () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  const result = await tool.execute({ node_type: "Judgment", limit: 5 }, {} as never);
  const output = asJson(result);
  const types = output.hits.map(hit => hit.nodeType);
  assert.ok(types.includes("SupremeCourtJudgment"), "应含最高法院判决");
  assert.ok(types.includes("RegionalCourtJudgment"), "应含地方法院判决");
});

test("patent_kg_query: 数据库缺失时 setup_required 且 execute 报错", async () => {
  const tool = createPatentKgQueryTool(() => null);
  const availability = await tool.checkAvailability?.({} as never);
  assert.equal(availability?.ok, false);
  assert.equal((availability as { code: string }).code, "setup_required");
  const result = await tool.execute({ query: "x" }, {} as never);
  const first = result.content[0];
  assert.equal(first?.type, "text");
  assert.match((first as { text: string }).text, /未找到专利知识图谱数据库/);
});

test("patent_kg_query: limit 钳制到 1..10", async () => {
  let receivedKeywordLimit = 0;
  const ref = makeRef();
  ref.adapter = {
    ...ref.adapter,
    searchRelevant: (_query: string, options?: { keywordLimit?: number }) => {
      receivedKeywordLimit = options?.keywordLimit ?? 0;
      return [];
    },
  } as unknown as PatentKgAdapter;
  const tool = createPatentKgQueryTool(() => ref);
  await tool.execute({ query: "x", limit: 100 }, {} as never);
  assert.equal(receivedKeywordLimit, 10);
  await tool.execute({ query: "x", limit: 0 }, {} as never);
  assert.equal(receivedKeywordLimit, 1);
});

test("patent_kg_query: include_content 附正文片段", async () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  const result = await tool.execute({ query: "三步法", include_content: true }, {} as never);
  const output = asJson(result);
  const rule = output.hits.find(hit => hit.id === "RULE_1");
  assert.equal(rule?.content, "rule-content");
});

test("patent_kg_query: 关键词模式使用 OR 分词检索", async () => {
  const receivedModes: Array<"phrase" | "or" | undefined> = [];
  const ref = makeRef();
  ref.adapter = {
    ...ref.adapter,
    searchRelevant: (_q: string, options?: { mode?: "phrase" | "or" }) => {
      receivedModes.push(options?.mode);
      return [];
    },
  } as unknown as PatentKgAdapter;
  const tool = createPatentKgQueryTool(() => ref);
  await tool.execute({ query: "创造性 三步法" }, {} as never);
  assert.ok(receivedModes.length > 0, "应调用 searchRelevant");
  assert.ok(
    receivedModes.every(mode => mode === "or"),
    "关键词模式应全部使用 or 分词",
  );
});

test("patent_kg_query: 多词/长词/窗口类 query 原样单次传参（拆词在 KgStore 内）", async () => {
  const calls: string[] = [];
  const ref = makeRef();
  ref.adapter = {
    ...ref.adapter,
    searchRelevant: (q: string) => {
      calls.push(q);
      return [];
    },
  } as unknown as PatentKgAdapter;
  const tool = createPatentKgQueryTool(() => ref);
  await tool.execute({ query: "创造性 三步法" }, {} as never);
  await tool.execute({ query: "创造性三步法判断规则" }, {} as never);
  await tool.execute({ query: "禁止反悔" }, {} as never);
  assert.deepEqual(calls, ["创造性 三步法", "创造性三步法判断规则", "禁止反悔"]);
});

test("patent_kg_query: id 模式邻居数量上限为 limit", async () => {
  const ref = makeRef();
  ref.adapter = {
    ...ref.adapter,
    getSimilarNodes: () => [
      { node: { id: "WIKI_1", nodeType: "WikiCard", title: "Bolar例外卡片" }, relation: "RELATED_TO" },
      { node: { id: "RULE_1", nodeType: "GuidelineRule", name: "三步法" }, relation: "SIMILAR_TO" },
    ],
    getNeighbors: (_id: string, relation: string) =>
      relation === "CITES"
        ? [
            { targetId: "JUDG_1", relation: "CITES" },
            { targetId: "JUDG_2", relation: "CITES" },
          ]
        : [],
  } as unknown as PatentKgAdapter;
  const tool = createPatentKgQueryTool(() => ref);
  const result = await tool.execute({ id: "CASE_005", limit: 2 }, {} as never);
  const output = asJson(result);
  assert.ok(output.hits[0]?.neighbors, "id 模式应返回邻居");
  assert.ok(output.hits[0]!.neighbors!.length <= 2, "相似+引用邻居合并后应截断到 limit");
});

test("patent_kg_query: 无有效输入返回错误", async () => {
  const tool = createPatentKgQueryTool(() => makeRef());
  const result = await tool.execute({}, {} as never);
  const first = result.content[0];
  assert.equal(first?.type, "text");
  assert.match((first as { text: string }).text, /请提供 query/);
});
