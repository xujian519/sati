import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import { PatentMemoryProvider } from "../../src/knowledge/patent/patent-memory-provider.js";
import { WikiCardLoader } from "../../src/knowledge/patent/wiki-card-loader.js";
import type { LegalSearchEngine } from "../../src/knowledge/legal/legal-search.js";
import { LegalMemoryProvider } from "../../src/knowledge/legal/legal-memory-provider.js";

/** 构造一张 wiki 卡的临时目录。 */
function makeFixtureWiki(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-wiki-cache-"));
  const cardsDir = join(dir, "patent-cards");
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(
    join(cardsDir, "creative.md"),
    [
      "- 概念: 创造性",
      "- 领域: 创造性判断",
      "",
      "创造性判断三步法：确定最接近的现有技术，确定区别技术特征与实际解决的技术问题，",
      "判断要求保护的发明相对于现有技术是否显而易见。",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("PatentMemoryProvider 检索缓存", () => {
  it("同 query 短时内命中缓存，不重复检索", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      let searchCalls = 0;
      const originalSearch = loader.search.bind(loader);
      loader.search = (keyword: string, limit?: number) => {
        searchCalls += 1;
        return originalSearch(keyword, limit);
      };
      const provider = new PatentMemoryProvider({
        wikiLoader: loader,
        embeddingDir: join(wikiDir, "embeddings"),
        logger: { warn: () => {} },
      });

      const query = "创造性";
      const first = await provider.retrieve(makeInput(query));
      assert.ok(first.systemContext?.includes("<wiki-card>"), "首次应注入 wiki 卡片");
      const callsAfterFirst = searchCalls;

      const second = await provider.retrieve(makeInput(query));
      assert.equal(searchCalls, callsAfterFirst, "缓存命中后不应再次检索");
      assert.ok(
        second.diagnostics.some(d => d.message.includes("缓存命中")),
        "缓存命中应有诊断标记",
      );
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });

  it("TTL 过期后重新检索", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      let searchCalls = 0;
      const originalSearch = loader.search.bind(loader);
      loader.search = (keyword: string, limit?: number) => {
        searchCalls += 1;
        return originalSearch(keyword, limit);
      };
      const provider = new PatentMemoryProvider({
        wikiLoader: loader,
        embeddingDir: join(wikiDir, "embeddings"),
        cacheTtlMs: 30,
        logger: { warn: () => {} },
      });

      const query = "创造性";
      await provider.retrieve(makeInput(query));
      const callsAfterFirst = searchCalls;
      await sleep(60); // 超过 30ms TTL

      const third = await provider.retrieve(makeInput(query));
      assert.ok(searchCalls > callsAfterFirst, "TTL 过期后应重新检索");
      assert.ok(!third.diagnostics.some(d => d.message.includes("缓存命中")));
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });

  it("cacheTtlMs=0 时禁用缓存", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      let searchCalls = 0;
      const originalSearch = loader.search.bind(loader);
      loader.search = (keyword: string, limit?: number) => {
        searchCalls += 1;
        return originalSearch(keyword, limit);
      };
      const provider = new PatentMemoryProvider({
        wikiLoader: loader,
        embeddingDir: join(wikiDir, "embeddings"),
        cacheTtlMs: 0,
        logger: { warn: () => {} },
      });

      const query = "创造性";
      await provider.retrieve(makeInput(query));
      const callsAfterFirst = searchCalls;
      await provider.retrieve(makeInput(query));
      assert.ok(searchCalls > callsAfterFirst, "禁用缓存时应每次都检索");
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });

  it("abort 信号下不写入缓存", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      let searchCalls = 0;
      const originalSearch = loader.search.bind(loader);
      loader.search = (keyword: string, limit?: number) => {
        searchCalls += 1;
        return originalSearch(keyword, limit);
      };
      const provider = new PatentMemoryProvider({
        wikiLoader: loader,
        embeddingDir: join(wikiDir, "embeddings"),
        logger: { warn: () => {} },
      });

      const controller = new AbortController();
      controller.abort();
      const query = "创造性";
      await provider.retrieve({ ...makeInput(query), signal: controller.signal });
      const callsAfterFirst = searchCalls;
      await provider.retrieve(makeInput(query));
      assert.ok(searchCalls > callsAfterFirst, "abort 时不缓存，下次应重新检索");
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });
});

describe("LegalMemoryProvider 检索缓存", () => {
  it("同 query 短时内命中缓存，FTS 不再重查", async () => {
    let searchCalls = 0;
    const engine = {
      search: () => {
        searchCalls += 1;
        return [];
      },
      getById: () => undefined,
    } as unknown as LegalSearchEngine;
    const provider = new LegalMemoryProvider(engine, { logger: { warn: () => {} } });

    const query = "专利法第二十二条关于新颖性的规定";
    await provider.retrieve(makeInput(query));
    assert.equal(searchCalls, 1);

    const second = await provider.retrieve(makeInput(query));
    assert.equal(searchCalls, 1, "缓存命中后不应再查 FTS");
    assert.ok(second.diagnostics.some(d => d.message.includes("缓存命中")));
  });
});
