import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import type { PatentKgAdapter } from "../../src/knowledge/patent/patent-kg-adapter.js";
import type { VectorDbSearch } from "../../src/knowledge/shared/vector-db.js";
import { PatentMemoryProvider } from "../../src/knowledge/patent/patent-memory-provider.js";
import type { LegalSearchEngine } from "../../src/knowledge/legal/legal-search.js";
import { LegalMemoryProvider } from "../../src/knowledge/legal/legal-memory-provider.js";

/** 恒抛错的 embedding 客户端（模拟端点宕机）。 */
function makeFailingEmbeddingClient(embedCalls: { count: number }): EmbeddingClient {
  return {
    dimensions: 2,
    async embed(): Promise<number[][]> {
      embedCalls.count += 1;
      throw new Error("embedding endpoint down");
    },
    async healthCheck(): Promise<boolean> {
      return false;
    },
  };
}

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

describe("PatentMemoryProvider KG 语义已移除", () => {
  it("KG 不建向量：embedding 故障不影响关键词检索（embed 不被调用）", async () => {
    const embedCalls = { count: 0 };
    const kgAdapter = {
      searchRelevant: () => [],
      getNode: () => undefined,
    } as unknown as PatentKgAdapter;
    const provider = new PatentMemoryProvider({
      kgAdapter,
      embedding: makeFailingEmbeddingClient(embedCalls),
      embeddingDir: "/tmp/sati-embedding-test",
      cacheTtlMs: 0,
      logger: { warn: () => {} },
    });

    const query = "这个技术方案是否具备创造性，怎么判断";
    for (let i = 0; i < 3; i += 1) {
      const result = await provider.retrieve(makeInput(query));
      assert.ok(result, "降级路径不应抛错");
    }
    assert.equal(embedCalls.count, 0, "KG 无语义路，embedding 不应被调用");
  });

  it("embedding 存在但 KG 无语义路：不触发 embed（关键词 0 命中返回空上下文）", async () => {
    const embedCalls = { count: 0 };
    const kgAdapter = {
      searchRelevant: () => [],
      getNode: () => undefined,
    } as unknown as PatentKgAdapter;
    const provider = new PatentMemoryProvider({
      kgAdapter,
      embedding: makeFailingEmbeddingClient(embedCalls),
      embeddingDir: "/tmp/sati-embedding-test",
      cacheTtlMs: 0,
      logger: { warn: () => {} },
    });

    const query = "判断权利要求是否清楚完整";
    await provider.retrieve(makeInput(query));
    await provider.retrieve(makeInput(query));
    await provider.retrieve(makeInput(query));
    assert.equal(embedCalls.count, 0, "KG 无语义路，embed 不应增长");
  });
});

describe("LegalMemoryProvider 语义召回熔断", () => {
  it("embedding 持续失败：达到阈值后短路，FTS 关键词路不受影响", async () => {
    const embedCalls = { count: 0 };
    const engine = {
      search: () => [],
      getById: () => undefined,
    } as unknown as LegalSearchEngine;
    const vectorDb = {
      hasCorpus: (corpus: string) => corpus === "law",
      search: () => [],
    } as unknown as VectorDbSearch;
    const provider = new LegalMemoryProvider(engine, {
      embedding: makeFailingEmbeddingClient(embedCalls),
      vectorDb,
      cacheTtlMs: 0,
      logger: { warn: () => {} },
    });

    const query = "专利法第二十二条关于新颖性的规定";
    for (let i = 0; i < 3; i += 1) {
      const result = await provider.retrieve(makeInput(query));
      assert.ok(result, "降级路径不应抛错");
    }
    assert.equal(embedCalls.count, 3);

    const result = await provider.retrieve(makeInput(query));
    assert.equal(embedCalls.count, 3, "熔断后不应再调用 embed");
    assert.ok(Array.isArray(result.diagnostics));
  });
});
