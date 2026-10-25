/**
 * R-08 golden queries：类型/分数过滤后的 top-3 节点类型必须落在期望集合内。
 *
 * 使用内存假 store（不触网、不依赖 knowledge.db），实例化真实 PatentKgAdapter，
 * 覆盖评分、nodeTypes 过滤与 minScore 过滤三条链路。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PatentKgAdapter } from "../../src/knowledge/patent/patent-kg-adapter.js";
import type { KgNode } from "../../src/knowledge/patent/types.js";
import type { KgStore } from "../../src/knowledge/shared/kg-store.js";

type GoldenCase = {
  query: string;
  nodes: KgNode[];
  expectedTop3Types: Set<string>;
};

const JUDGMENT_TYPES = new Set(["SupremeCourtJudgment", "RegionalCourtJudgment", "Case"]);

function makeStore(nodes: KgNode[]): KgStore {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return {
    searchByKeyword: (keyword: string, limit: number) => {
      const terms = keyword
        .split(/[\s,，;；、|/]+/)
        .map(term => term.trim())
        .filter(Boolean);
      return nodes
        .filter(node => {
          const hay = `${node.name ?? ""} ${node.title ?? ""} ${node.content ?? ""}`;
          return terms.some(term => hay.includes(term));
        })
        .slice(0, limit);
    },
    getNeighbors: () => [],
    getNode: (id: string) => byId.get(id),
    listByType: () => [],
  } as unknown as KgStore;
}

function node(id: string, nodeType: string, title: string, content = ""): KgNode {
  return { id, nodeType, title, content };
}

const GOLDEN_CASES: GoldenCase[] = [
  {
    query: "创造性",
    nodes: [
      node("c1", "GuidelineRule", "创造性判断三步法", "创造性 技术启示"),
      node("c2", "Case", "创造性案例：技术启示认定", "创造性"),
      node("c3", "SupremeCourtJudgment", "创造性判决", "创造性"),
      node("c4", "WikiCard", "侵权-原理-专利权评价报告", "侵权"),
    ],
    expectedTop3Types: new Set(["GuidelineRule", ...JUDGMENT_TYPES]),
  },
  {
    query: "新颖性",
    nodes: [
      node("n1", "GuidelineRule", "新颖性判断规则", "新颖性 单独对比"),
      node("n2", "Case", "新颖性案例", "新颖性"),
      node("n3", "WikiCard", "新颖性卡片", "新颖性"),
    ],
    expectedTop3Types: new Set(["GuidelineRule", ...JUDGMENT_TYPES, "WikiCard"]),
  },
  {
    query: "侵权",
    nodes: [
      node("i1", "GuidelineRule", "侵权判断规则", "侵权 等同"),
      node("i2", "Case", "侵权案例", "侵权"),
      node("i3", "RegionalCourtJudgment", "侵权判决", "侵权"),
    ],
    expectedTop3Types: new Set(["GuidelineRule", ...JUDGMENT_TYPES]),
  },
  {
    query: "权利要求清楚性",
    nodes: [
      node("q1", "GuidelineRule", "权利要求清楚性审查", "权利要求 清楚性"),
      node("q2", "Case", "权利要求清楚性案例", "清楚性"),
      node("q3", "Concept", "清楚性概念", "权利要求清楚性"),
    ],
    expectedTop3Types: new Set(["GuidelineRule", ...JUDGMENT_TYPES, "Concept"]),
  },
  {
    query: "无效证据",
    nodes: [
      node("e1", "Evidence", "无效证据：公开出版物", "无效证据"),
      node("e2", "Case", "无效证据案例", "无效证据"),
      node("e3", "GuidelineRule", "无效证据审查规则", "无效证据"),
    ],
    expectedTop3Types: new Set(["Evidence", ...JUDGMENT_TYPES, "GuidelineRule"]),
  },
];

for (const golden of GOLDEN_CASES) {
  test(`golden query "${golden.query}"：top-3 类型在期望集合内且带 score`, () => {
    const adapter = new PatentKgAdapter(makeStore(golden.nodes));
    const hits = adapter.searchRelevant(golden.query, { keywordLimit: 5, mode: "or" });
    assert.ok(hits.length > 0, "应有命中");
    for (const hit of hits) {
      assert.equal(typeof hit.score, "number");
      assert.ok(hit.score >= 0 && hit.score <= 1, `score ${hit.score} out of range`);
    }
    for (const hit of hits.slice(0, 3)) {
      assert.ok(
        golden.expectedTop3Types.has(hit.node.nodeType),
        `${golden.query} top-3 contains unexpected type ${hit.node.nodeType}`,
      );
    }
  });
}

test("nodeTypes 过滤只保留指定类型（支持 Judgment 别名）", () => {
  const adapter = new PatentKgAdapter(makeStore(GOLDEN_CASES[0]!.nodes));
  const hits = adapter.searchRelevant("创造性", { keywordLimit: 5, nodeTypes: ["Judgment"] });
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.ok(
      hit.node.nodeType === "SupremeCourtJudgment" || hit.node.nodeType === "RegionalCourtJudgment",
      `unexpected type ${hit.node.nodeType}`,
    );
  }
});

test("minScore 过滤低相关性命中，结果按 score 降序", () => {
  const adapter = new PatentKgAdapter(makeStore(GOLDEN_CASES[0]!.nodes));
  const hits = adapter.searchRelevant("创造性", { keywordLimit: 5, minScore: 0.9 });
  assert.ok(hits.length > 0);
  for (const hit of hits) assert.ok(hit.score >= 0.9);
  const scores = hits.map(hit => hit.score);
  assert.deepEqual(
    scores,
    [...scores].sort((a, b) => b - a),
  );
});
