/**
 * 测试: src/patent/data/nuo/patentCache — 检索/点查结果缓存（LRU + TTL + 并发合并）。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PatentSearchResult, ScrapeResult } from "nuo-patent";
import {
  AsyncResultCache,
  cachedScrapePatent,
  cachedSearchPatents,
  isScrapeResultCacheable,
  isSearchResultCacheable,
  resetPatentCacheSingletons,
  searchCacheKey,
  searchResultTtlMs,
} from "../../../../src/patent/data/nuo/patentCache.js";

function makeSearchResult(overrides: Partial<PatentSearchResult> = {}): PatentSearchResult {
  return {
    query: "thermal",
    total: 1,
    hits: [
      {
        patent: "US11452699B2",
        title: "Thermal management system",
        assignee: "Apple Inc.",
        publication_date: "2022-09-27",
        priority_date: "2019-12-31",
        abstract: "A thermal management system.",
        url: "https://patents.google.com/patent/US11452699B2",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function makeScrapeResult(overrides: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    success: true,
    patent: "US11452699B2",
    url: "https://patents.google.com/patent/US11452699B2",
    data: {
      title: "Thermal management system",
      application_number: "17/000,000",
      inventor_name: '[{"inventor_name":"John"}]',
      assignee_name_orig: '[{"assignee_name":"Apple"}]',
      assignee_name_current: "",
      pub_date: "2022-09-27",
      filing_date: "2019-12-31",
      priority_date: "2019-12-31",
      grant_date: "",
      expiration_date: "",
      legal_status: "",
      ifi_status: "",
      estimated_expiration: "",
      pdf_url: "https://patents.google.com/patent/US11452699B2/en?oq=US11452699B2",
      classifications: '["F28D"]',
      backward_cite_no_family: "[]",
      backward_cite_yes_family: "[]",
      forward_cite_no_family: "[]",
      forward_cite_yes_family: "[]",
      abstract_text: "A thermal management system.",
    },
    errorCode: "",
    errorMessage: "",
    parseWarnings: [],
    ...overrides,
  };
}

describe("AsyncResultCache", () => {
  it("命中缓存不重复调用 loader", async () => {
    let calls = 0;
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 });
    const loader = async () => {
      calls += 1;
      return `v${calls}`;
    };
    assert.equal(await cache.getOrLoad("k", loader), "v1");
    assert.equal(await cache.getOrLoad("k", loader), "v1");
    assert.equal(calls, 1);
  });

  it("并发同 key 只触发一次 loader（in-flight 合并）", async () => {
    let calls = 0;
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const loader = async () => {
      calls += 1;
      await gate;
      return "done";
    };
    const p1 = cache.getOrLoad("k", loader);
    const p2 = cache.getOrLoad("k", loader);
    const p3 = cache.getOrLoad("k", loader);
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.deepEqual([r1, r2, r3], ["done", "done", "done"]);
    assert.equal(calls, 1, "并发同 key 应共享同一次底层请求");
  });

  it("TTL 过期后重新加载", async () => {
    let calls = 0;
    const cache = new AsyncResultCache<string>({ ttlMs: 1 });
    const loader = async () => {
      calls += 1;
      return `v${calls}`;
    };
    assert.equal(await cache.getOrLoad("k", loader), "v1");
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(await cache.getOrLoad("k", loader), "v2");
    assert.equal(calls, 2);
  });

  it("LRU 容量淘汰最久未用", async () => {
    const cache = new AsyncResultCache<string>({ maxEntries: 2 });
    let calls = 0;
    const loader = async (n: string) => {
      calls += 1;
      return `v${n}`;
    };
    await cache.getOrLoad("a", () => loader("a"));
    await cache.getOrLoad("b", () => loader("b"));
    // 访问 a 使其成为最近使用，再插入 c → 淘汰 b
    await cache.getOrLoad("a", () => loader("a"));
    await cache.getOrLoad("c", () => loader("c"));
    assert.equal(await cache.getOrLoad("a", () => loader("a")), "va");
    assert.equal(await cache.getOrLoad("b", () => loader("b")), "vb", "b 应已被淘汰，重新加载");
    assert.equal(calls, 4);
  });

  it("loader 抛错不写缓存，下次重试", async () => {
    let calls = 0;
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 });
    const loader = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return "ok";
    };
    await assert.rejects(() => cache.getOrLoad("k", loader), /network down/);
    assert.equal(await cache.getOrLoad("k", loader), "ok");
    assert.equal(calls, 2);
  });

  it("shouldCache=false 时结果透传但不缓存", async () => {
    let calls = 0;
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 });
    const loader = async () => {
      calls += 1;
      return "transient";
    };
    assert.equal(await cache.getOrLoad("k", loader, () => false), "transient");
    assert.equal(await cache.getOrLoad("k", loader, () => false), "transient");
    assert.equal(calls, 2, "shouldCache=false 应每次重新加载");
  });
});

describe("isSearchResultCacheable / isScrapeResultCacheable", () => {
  it("成功检索可缓存", () => {
    assert.equal(isSearchResultCacheable(makeSearchResult()), true);
  });
  it("失败/超时/空查询 warning 不可缓存", () => {
    assert.equal(isSearchResultCacheable(makeSearchResult({ warnings: ["检索失败: network down"] })), false);
    assert.equal(isSearchResultCacheable(makeSearchResult({ warnings: ["检索超时 (30000ms)"] })), false);
    assert.equal(isSearchResultCacheable(makeSearchResult({ warnings: ["查询条件为空"] })), false);
  });
  it("解析类 warning 仍可缓存（非致命）", () => {
    assert.equal(isSearchResultCacheable(makeSearchResult({ warnings: ["搜索结果页未解析到任何结果"] })), true);
  });
  it("点查 success=true 可缓存，其余不可", () => {
    assert.equal(isScrapeResultCacheable(makeScrapeResult()), true);
    assert.equal(isScrapeResultCacheable(makeScrapeResult({ success: false, errorCode: "NOT_FOUND" })), false);
    assert.equal(isScrapeResultCacheable(makeScrapeResult({ success: false, errorCode: "TIMEOUT" })), false);
  });
});

describe("cachedSearchPatents / cachedScrapePatent", () => {
  // 无 options 调用共享进程级缓存单例（跨用例同 key 可能互串），每个用例前清空。
  beforeEach(() => {
    resetPatentCacheSingletons();
  });

  it("同一检索式 TTL 内只打一次底层", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeSearchResult();
    };
    const wrapped = cachedSearchPatents(impl);
    await wrapped("thermal");
    await wrapped("thermal");
    await wrapped("thermal", { limit: 10 }); // 同 limit → 同 key
    assert.equal(calls, 1);
  });

  it("不同 limit 使用不同 key", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeSearchResult();
    };
    const wrapped = cachedSearchPatents(impl);
    await wrapped("thermal", { limit: 5 });
    await wrapped("thermal", { limit: 10 });
    assert.equal(calls, 2);
  });

  it("失败检索不缓存", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeSearchResult({ hits: [], total: 0, warnings: ["检索失败: network down"] });
    };
    const wrapped = cachedSearchPatents(impl);
    await wrapped("thermal");
    await wrapped("thermal");
    assert.equal(calls, 2, "失败态不应写入缓存");
  });

  it("同一专利号 TTL 内只打一次底层；NOT_FOUND 不缓存", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return calls === 1
        ? makeScrapeResult({ success: false, errorCode: "NOT_FOUND", errorMessage: "not found" })
        : makeScrapeResult();
    };
    const wrapped = cachedScrapePatent(impl);
    const first = await wrapped("US11452699B2");
    assert.equal(first.success, false);
    const second = await wrapped("US11452699B2");
    assert.equal(second.success, true);
    assert.equal(calls, 2, "NOT_FOUND 不缓存，重试可触达源");
  });

  it("成功点查缓存命中", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeScrapeResult();
    };
    const wrapped = cachedScrapePatent(impl);
    await wrapped("US11452699B2");
    await wrapped("US11452699B2");
    assert.equal(calls, 1);
  });

  it("#11: 不同 impl 共享缓存互不污染（同一业务 key 各自打底层）", async () => {
    let callsA = 0;
    let callsB = 0;
    const implA = async () => {
      callsA += 1;
      return makeSearchResult({ query: "thermal" });
    };
    const implB = async () => {
      callsB += 1;
      return makeSearchResult({ query: "thermal", total: 999 });
    };
    const wrappedA = cachedSearchPatents(implA);
    const wrappedB = cachedSearchPatents(implB);
    // 同一检索式先由 A 缓存
    await wrappedA("thermal");
    await wrappedA("thermal");
    assert.equal(callsA, 1, "同一 impl 内 TTL 命中（共享缓存语义保持）");
    // B 用同一业务 key：不得命中 A 的缓存（不同 impl 结果可能不同）
    await wrappedB("thermal");
    assert.equal(callsB, 1, "B 第一次调用不得命中 A 的缓存（互不污染）");
    await wrappedB("thermal");
    assert.equal(callsB, 1, "B 自己的缓存命中（TTL 内）");
    // A 的缓存不受 B 影响
    await wrappedA("thermal");
    assert.equal(callsA, 1, "A 的缓存仍命中");
  });

  it("#11: 同一 impl 函数引用跨包装调用共享缓存（registry 重建语义）", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeSearchResult();
    };
    // 模拟 registry 重建：同一 impl 重新包装两次
    const first = cachedSearchPatents(impl);
    await first("thermal");
    const second = cachedSearchPatents(impl);
    await second("thermal");
    assert.equal(calls, 1, "同一 impl 跨重建应共享缓存（M9：不重新 spawn 浏览器）");
    // reset 后失效
    resetPatentCacheSingletons();
    await second("thermal");
    assert.equal(calls, 2, "reset 后缓存失效");
  });
});

describe("P3-01 TTL 分层", () => {
  it("分类：零命中 1min / 法律状态 5min / 其余 2h", () => {
    const empty = makeSearchResult({ hits: [], total: 0 });
    assert.equal(searchResultTtlMs(searchCacheKey("thermal", 10), empty), 60 * 1000, "零命中 1min");

    const withHits = makeSearchResult();
    assert.equal(
      searchResultTtlMs(searchCacheKey("法律状态 CN115690481A", 10), withHits),
      5 * 60 * 1000,
      "中文法律状态关键词 5min",
    );
    assert.equal(
      searchResultTtlMs(searchCacheKey("legal status US11452699B2", 10), withHits),
      5 * 60 * 1000,
      "英文 legal status 5min（大小写不敏感）",
    );
    assert.equal(
      searchResultTtlMs(searchCacheKey("无效宣告审查决定", 10), withHits),
      5 * 60 * 1000,
      "无效类关键词 5min",
    );

    assert.equal(searchResultTtlMs(searchCacheKey("thermal", 10), withHits), 2 * 60 * 60 * 1000, "其余 2h");
  });

  it("零命中类：TTL 到期后重拉（注入 1ms 分类 TTL 模拟到期）", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeSearchResult({ hits: [], total: 0 });
    };
    // 50ms 而非 1ms：Windows 事件循环 tick 即可超 1ms，两次连续调用会被误判过期。
    const wrapped = cachedSearchPatents(impl, { ttlFor: () => 50 });
    await wrapped("thermal");
    await wrapped("thermal");
    assert.equal(calls, 1, "分类 TTL 内命中");
    await new Promise(resolve => setTimeout(resolve, 80));
    await wrapped("thermal");
    assert.equal(calls, 2, "零命中类 TTL 到期后重拉");
  });

  it("法律状态类：TTL 到期后重拉（注入 1ms 分类 TTL 模拟到期）", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeSearchResult();
    };
    const wrapped = cachedSearchPatents(impl, { ttlFor: () => 50 });
    await wrapped("法律状态 CN115690481A");
    await wrapped("法律状态 CN115690481A");
    assert.equal(calls, 1, "分类 TTL 内命中");
    await new Promise(resolve => setTimeout(resolve, 80));
    await wrapped("法律状态 CN115690481A");
    assert.equal(calls, 2, "法律状态类 TTL 到期后重拉");
  });

  it("其余类：默认 2h 内命中、ttlFor 返回 undefined 时回退默认 TTL", async () => {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return makeSearchResult();
    };
    const wrapped = cachedSearchPatents(impl);
    await wrapped("thermal");
    await wrapped("thermal");
    assert.equal(calls, 1, "其余类默认 2h 内命中");
    // ttlFor 返回 undefined → 回退构造时 ttlMs（50ms），到期重拉
    const fallback = cachedSearchPatents(impl, { ttlMs: 50, ttlFor: () => undefined });
    await fallback("thermal");
    await new Promise(resolve => setTimeout(resolve, 80));
    await fallback("thermal");
    assert.equal(calls, 3, "ttlFor 未命中时回退默认 TTL，到期后重拉");
  });
});
