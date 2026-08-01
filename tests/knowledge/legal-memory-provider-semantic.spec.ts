import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import type { RerankClient } from "../../src/model/embedding/rerank.js";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import { LegalMemoryProvider } from "../../src/knowledge/legal/legal-memory-provider.js";
import type { LegalSearchEngine } from "../../src/knowledge/legal/legal-search.js";
import type { VectorDbSearch, VectorDbSearchHit } from "../../src/knowledge/shared/vector-db.js";
import type { LawRecord } from "../../src/knowledge/legal/types.js";

function makeStubEmbedding(): EmbeddingClient {
  return {
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => [text.includes("赔偿") ? 1 : 0, text.includes("侵权") ? 1 : 0]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

function makeLawRecord(id: string, name: string): LawRecord {
  return {
    id,
    level: "法律",
    name,
    publish: "2020-01-01",
    expired: 0,
    categoryId: 1,
    content: `${name}全文内容（语义命中）`,
    categoryName: "民法商法",
  };
}

function makeStubEngine(): LegalSearchEngine {
  const laws = new Map([
    ["law-1", makeLawRecord("law-1", "专利法")],
    ["law-2", makeLawRecord("law-2", "商标法")],
  ]);
  return {
    search: () => [],
    getById: (id: string) => laws.get(id),
  } as unknown as LegalSearchEngine;
}

function makeStubVectorDb(hits: VectorDbSearchHit[]): VectorDbSearch {
  return {
    hasCorpus: (corpus: string) => corpus === "law",
    dimensionsOf: () => 2,
    loadedChunkCount: () => hits.length,
    search: () => hits,
    close: () => {},
  } as unknown as VectorDbSearch;
}

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

describe("legal-memory-provider 法条语义召回", () => {
  it("FTS 漏召回时语义路径注入 <law-database>", async () => {
    const provider = new LegalMemoryProvider(makeStubEngine(), {
      embedding: makeStubEmbedding(),
      vectorDb: makeStubVectorDb([
        { docId: "law-1", score: 0.9 },
        { docId: "law-2", score: 0.7 },
      ]),
      limit: 2,
    });
    const result = await provider.retrieve(makeInput("侵权赔偿的法定标准"));
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes("<law-database>"));
    assert.ok(result.systemContext.includes("专利法"));
    assert.ok(result.systemContext.includes("商标法"));
    assert.ok(result.diagnostics.some(d => d.code === "memory_context_empty"));
  });

  it("FTS 命中与语义命中 RRF 融合（FTS 缺失时语义兜底）", async () => {
    const engine = makeStubEngine();
    const provider = new LegalMemoryProvider(engine, {
      embedding: makeStubEmbedding(),
      vectorDb: makeStubVectorDb([{ docId: "law-1", score: 0.9 }]),
      limit: 1,
    });
    const result = await provider.retrieve(makeInput("侵权赔偿的法定标准"));
    assert.ok(result.systemContext?.includes("专利法"));
  });

  it("未配置 vectorDb 且 FTS 无命中时返回空上下文（回归）", async () => {
    const provider = new LegalMemoryProvider(makeStubEngine(), { embedding: makeStubEmbedding() });
    const result = await provider.retrieve(makeInput("侵权赔偿的法定标准"));
    assert.equal(result.systemContext, undefined);
  });

  it("语义检索抛错时降级为纯 FTS（不阻断）", async () => {
    const failingVectorDb = {
      hasCorpus: () => true,
      search: () => {
        throw new Error("vectors.db corrupt");
      },
    } as unknown as VectorDbSearch;
    const provider = new LegalMemoryProvider(makeStubEngine(), {
      embedding: makeStubEmbedding(),
      vectorDb: failingVectorDb,
    });
    // FTS 无命中 + 语义失败 → 空上下文，但不抛错
    const result = await provider.retrieve(makeInput("侵权赔偿的法定标准"));
    assert.equal(result.systemContext, undefined);
  });

  it("rerank 重排候选顺序（FTS 无命中时语义候选按 rerank 顺序注入）", async () => {
    const rerankCalls: string[][] = [];
    const stubRerank: RerankClient = {
      async rerank(_query: string, documents: string[]): Promise<Array<{ index: number; score: number }>> {
        rerankCalls.push(documents);
        // 逆序打分并已按分数降序返回：最后一个文档最相关
        return documents.map((_, index) => ({ index, score: index })).reverse();
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };
    const provider = new LegalMemoryProvider(makeStubEngine(), {
      embedding: makeStubEmbedding(),
      vectorDb: makeStubVectorDb([
        { docId: "law-1", score: 0.9 },
        { docId: "law-2", score: 0.8 },
      ]),
      rerank: stubRerank,
      limit: 2,
    });
    const result = await provider.retrieve(makeInput("侵权赔偿的法定标准"));
    assert.ok(result.systemContext);
    assert.equal(rerankCalls.length, 1);
    // rerank 逆序后，最后注入的应为 law-2（商标法）——验证顺序被重排
    const lawIndex = result.systemContext!.indexOf("商标法");
    const patentIndex = result.systemContext!.indexOf("专利法");
    assert.ok(lawIndex >= 0 && patentIndex >= 0);
    assert.ok(lawIndex < patentIndex, "rerank 后商标法应排在专利法之前");
  });
});
