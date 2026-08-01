import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import type { RerankClient } from "../../src/model/embedding/rerank.js";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import { PatentMemoryProvider } from "../../src/knowledge/patent/patent-memory-provider.js";
import type { PatentKgAdapter } from "../../src/knowledge/patent/patent-kg-adapter.js";
import type { VectorDbSearch, VectorDbSearchHit } from "../../src/knowledge/shared/vector-db.js";

/** 概念感知 stub embedding：创造性→d0，外观设计→d1。 */
function makeStubEmbedding(): EmbeddingClient {
  const score = (text: string, keyword: string): number => {
    const count = (text.match(new RegExp(keyword, "g")) ?? []).length;
    return count > 0 ? 1 + count * 0.1 : 0;
  };
  return {
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => [
        score(text, "创造") + score(text, "三步法"),
        score(text, "外观") + score(text, "设计"),
      ]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

function makeStubKgAdapter(): PatentKgAdapter {
  const nodes = new Map<string, { id: string; nodeType: string; name?: string; title?: string }>([
    ["kw-1", { id: "kw-1", nodeType: "Concept", name: "创造性" }],
    ["sem-1", { id: "sem-1", nodeType: "GuidelineRule", name: "三步法判断规则" }],
    ["sem-2", { id: "sem-2", nodeType: "Case", name: "某创造性案例" }],
  ]);
  return {
    searchRelevant: () => [{ node: nodes.get("kw-1")!, via: "keyword" }],
    getNode: (id: string) => nodes.get(id),
    getCitationChain: () => null,
    getSimilarNodes: () => [],
    listByType: () => [],
  } as unknown as PatentKgAdapter;
}

function makeStubVectorDb(hits: VectorDbSearchHit[]): VectorDbSearch {
  return {
    hasCorpus: (corpus: string) => corpus === "kg",
    dimensionsOf: () => 2,
    loadedChunkCount: () => hits.length,
    search: () => hits,
    close: () => {},
  } as unknown as VectorDbSearch;
}

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

describe("patent-memory-provider KG 语义召回", () => {
  it("关键词漏召回时语义路径注入（标记（语义））", async () => {
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(),
      embedding: makeStubEmbedding(),
      vectorDb: makeStubVectorDb([
        { docId: "sem-1", score: 0.9 },
        { docId: "sem-2", score: 0.8 },
      ]),
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes("<knowledge-graph>"));
    assert.ok(result.systemContext.includes("三步法判断规则"));
    assert.ok(result.systemContext.includes("（语义）"));
    assert.ok(result.systemContext.includes("创造性"), "关键词路仍应参与");
  });

  it("未配置 vectorDb 时仅关键词路（回归）", async () => {
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(),
      embedding: makeStubEmbedding(),
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext?.includes("<knowledge-graph>"));
    assert.ok(result.systemContext?.includes("创造性"));
    assert.ok(!result.systemContext?.includes("（语义）"));
  });

  it("语义检索抛错时降级为纯关键词（不阻断）", async () => {
    const failingVectorDb = {
      hasCorpus: () => true,
      dimensionsOf: () => 2,
      search: () => {
        throw new Error("vectors.db corrupt");
      },
    } as unknown as VectorDbSearch;
    const provider = new PatentMemoryProvider({
      kgAdapter: makeStubKgAdapter(),
      embedding: makeStubEmbedding(),
      vectorDb: failingVectorDb,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext?.includes("<knowledge-graph>"));
    assert.ok(result.systemContext?.includes("创造性"));
  });

  it("rerank 重排融合候选顺序", async () => {
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
      embedding: makeStubEmbedding(),
      vectorDb: makeStubVectorDb([
        { docId: "sem-1", score: 0.9 },
        { docId: "sem-2", score: 0.8 },
      ]),
      rerank: stubRerank,
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext?.includes("<knowledge-graph>"));
    // rerank 逆序：原序 [创造性(kw), 三步法判断规则(sem-1), 某创造性案例(sem-2)]
    // 逆序后 [某创造性案例, 三步法判断规则, 创造性]
    const caseIndex = result.systemContext!.indexOf("某创造性案例");
    const ruleIndex = result.systemContext!.indexOf("三步法判断规则");
    assert.ok(caseIndex >= 0 && ruleIndex >= 0);
    assert.ok(caseIndex < ruleIndex, "rerank 后案例应排在规则之前");
  });

  it("rerank 抛错时保持原序（不阻断）", async () => {
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
      embedding: makeStubEmbedding(),
      vectorDb: makeStubVectorDb([{ docId: "sem-1", score: 0.9 }]),
      rerank: failingRerank,
      graphLimit: 3,
    });
    const result = await provider.retrieve(makeInput("判断一个技术方案是否具有创造性"));
    assert.ok(result.systemContext?.includes("三步法判断规则"), "rerank 失败后语义命中仍注入");
  });
});
