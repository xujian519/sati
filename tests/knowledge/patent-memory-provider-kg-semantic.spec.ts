import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import type { RerankClient } from "../../src/model/embedding/rerank.js";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import { PatentMemoryProvider } from "../../src/knowledge/patent/patent-memory-provider.js";
import type { PatentKgAdapter } from "../../src/knowledge/patent/patent-kg-adapter.js";

/**
 * patent-memory-provider KG 关键词检索测试。
 *
 * 设计约束（import-xiaonuo-knowledge）：KG 节点不建向量（与 XiaoNuo 一致），
 * 图谱检索为关键词 + 关系扩展，无"（语义）"来源；vectorDb 不再注入。
 */

function makeStubEmbedding(): EmbeddingClient {
  return {
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [0, 0]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

function makeStubKgAdapter(hitCount = 2): PatentKgAdapter {
  const nodes = new Map<string, { id: string; nodeType: string; name?: string; title?: string }>([
    ["kw-1", { id: "kw-1", nodeType: "Concept", name: "创造性" }],
    ["kw-2", { id: "kw-2", nodeType: "GuidelineRule", name: "三步法判断规则" }],
    ["kw-3", { id: "kw-3", nodeType: "Case", name: "某创造性案例" }],
  ]);
  const hits = (
    [
      { node: nodes.get("kw-1")!, via: "keyword" as const },
      { node: nodes.get("kw-2")!, via: "keyword" as const },
      { node: nodes.get("kw-3")!, via: "keyword" as const },
    ] as const
  ).slice(0, hitCount) as unknown as Array<{
    node: { id: string; nodeType: string; name?: string; title?: string };
    via: "keyword";
  }>;
  return {
    searchRelevant: () => hits,
    getNode: (id: string) => nodes.get(id),
    getCitationChain: () => null,
    getSimilarNodes: () => [],
    listByType: () => [],
    // stub 无 FTS 表，探测结果为 none（等价 FTS5 不可用回退 LIKE 的降级语义）。
    ftsMode: () => "none" as const,
  } as unknown as PatentKgAdapter;
}

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

describe("patent-memory-provider KG 关键词检索（不建向量）", () => {
  it("关键词路命中注入 <knowledge-graph>，无（语义）标记", async () => {
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(),
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext, "应注入知识图谱上下文");
    assert.ok(result.systemContext.includes("<knowledge-graph>"));
    assert.ok(result.systemContext.includes("创造性"));
    assert.ok(result.systemContext.includes("三步法判断规则"));
    assert.ok(!result.systemContext.includes("（语义）"), "KG 不建向量，不应产生语义来源");
  });

  it("配置 embedding 也不会产生 KG 语义来源（仅 wiki 卡语义可用）", async () => {
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(),
      embedding: makeStubEmbedding(),
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext, "应注入知识图谱上下文");
    assert.ok(result.systemContext.includes("<knowledge-graph>"));
    assert.ok(result.systemContext.includes("创造性"));
    assert.ok(!result.systemContext.includes("（语义）"));
  });

  it("关键词 0 命中时返回空上下文（不注入空图谱块）", async () => {
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(0),
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("今天天气如何"));
    assert.ok(!result.systemContext?.includes("<knowledge-graph>"));
  });

  it("rerank 重排关键词候选顺序", async () => {
    const stubRerank: RerankClient = {
      async rerank(_query: string, documents: string[]): Promise<Array<{ index: number; score: number }>> {
        // 逆序打分并已按分数降序返回：最后一个候选最相关
        return documents.map((_, index) => ({ index, score: index })).reverse();
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(),
      rerank: stubRerank,
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext?.includes("<knowledge-graph>"));
    // 原序 [创造性, 三步法判断规则] → rerank 逆序 → [三步法判断规则, 创造性]
    const ruleIndex = result.systemContext!.indexOf("三步法判断规则");
    const conceptIndex = result.systemContext!.indexOf("创造性");
    assert.ok(ruleIndex >= 0 && conceptIndex >= 0);
    assert.ok(ruleIndex < conceptIndex, "rerank 后规则应排在概念之前");
  });

  it("rerank 抛错时保持关键词原序（不阻断）", async () => {
    const failingRerank = {
      async rerank(): Promise<Array<{ index: number; score: number }>> {
        throw new Error("rerank service down");
      },
      async healthCheck(): Promise<boolean> {
        return false;
      },
    } as unknown as RerankClient;
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(),
      rerank: failingRerank,
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext?.includes("创造性"), "rerank 失败后关键词命中仍注入");
  });
});
