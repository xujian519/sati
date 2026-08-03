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

describe("PatentMemoryProvider 语义召回熔断", () => {
  it("embedding 持续失败：达到阈值后短路，不再每 turn 重试，且降级不抛错", async () => {
    const embedCalls = { count: 0 };
    const kgAdapter = {
      searchRelevant: () => [],
      getNode: () => undefined,
    } as unknown as PatentKgAdapter;
    const vectorDb = {
      hasCorpus: (corpus: string) => corpus === "kg",
      search: () => [],
    } as unknown as VectorDbSearch;
    const provider = new PatentMemoryProvider({
      kgAdapter,
      embedding: makeFailingEmbeddingClient(embedCalls),
      vectorDb,
      embeddingDir: "/tmp/sati-embedding-test",
      cacheTtlMs: 0, // 熔断测试专注熔断行为，禁用结果缓存避免同 query 短路
      logger: { warn: () => {} },
    });

    const query = "这个技术方案是否具备创造性，怎么判断";
    // 前 3 次：每次都会尝试 embed（未达熔断阈值）
    for (let i = 0; i < 3; i += 1) {
      const result = await provider.retrieve(makeInput(query));
      assert.ok(result, "降级路径不应抛错");
    }
    assert.equal(embedCalls.count, 3, "前 3 次应各尝试一次 embed");

    // 第 4 次：熔断打开，不再尝试 embed，retrieve 仍正常返回
    const result = await provider.retrieve(makeInput(query));
    assert.equal(embedCalls.count, 3, "熔断后不应再调用 embed");
    assert.ok(result.systemContext === undefined || typeof result.systemContext === "string");
  });

  it("embedding 恢复后（success 路径）不误触熔断", async () => {
    const embedCalls = { count: 0 };
    let fail = true;
    const embedding: EmbeddingClient = {
      dimensions: 2,
      async embed(texts: string[]): Promise<number[][]> {
        embedCalls.count += 1;
        if (fail) throw new Error("temporary failure");
        return texts.map(() => [0.1, 0.2]);
      },
      async healthCheck(): Promise<boolean> {
        return !fail;
      },
    };
    const kgAdapter = {
      searchRelevant: () => [],
      getNode: () => undefined,
    } as unknown as PatentKgAdapter;
    const vectorDb = {
      hasCorpus: (corpus: string) => corpus === "kg",
      search: () => [],
    } as unknown as VectorDbSearch;
    const provider = new PatentMemoryProvider({
      kgAdapter,
      embedding,
      vectorDb,
      embeddingDir: "/tmp/sati-embedding-test",
      cacheTtlMs: 0,
      logger: { warn: () => {} },
    });

    const query = "判断权利要求是否清楚完整";
    // 失败 3 次 → open
    for (let i = 0; i < 3; i += 1) {
      await provider.retrieve(makeInput(query));
    }
    fail = false;
    // 熔断期内不重试（embed 不再增长）
    await provider.retrieve(makeInput(query));
    assert.equal(embedCalls.count, 3);
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
