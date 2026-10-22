import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { PatentSearchResult } from "nuo-patent";
import { ConnectorRegistry } from "../../../../src/literature/index.js";
import type { Connector, ConnectorHit } from "../../../../src/literature/index.js";
import {
  buildGooglePatentsXhrUrl,
  createMultiSourceSearchProvider,
  createNuoSearchProvider,
  createPaperSearchSource,
  decodeHtmlEntities,
  extractJsonText,
  withEgoJsonSearch,
} from "../../../../src/patent/data/nuo/searchProvider.js";

/** 构造 nuo-patent 形状的检索命中。 */
function hit(
  overrides: Partial<{
    patent: string;
    title: string;
    assignee: string;
    publication_date: string;
    priority_date: string;
    abstract: string;
    url: string;
  }> = {},
) {
  return {
    patent: "CN1234567A",
    title: "示例专利",
    assignee: "示例公司",
    publication_date: "",
    priority_date: "",
    abstract: "摘要",
    url: "https://patents.google.com/patent/CN1234567A",
    ...overrides,
  };
}

test("searchProvider: 公开日映射进检索命中（publication_date 透传）", async () => {
  const provider = createNuoSearchProvider({
    search: async () => ({
      query: "q",
      total: 2,
      warnings: [],
      hits: [
        hit({ patent: "CN1", publication_date: "2020-02-21", priority_date: "2019-01-01" }),
        hit({ patent: "CN2" }), // 无公开日（旧数据）
      ],
    }),
  });
  const docs = await provider.search!("散热器", { maxResults: 5 });
  assert.equal(docs.length, 2);
  assert.equal(docs[0]!.publication_date, "2020-02-21");
  // 空公开日映射为 undefined，保持旧 provider 形状（向后兼容，不出现空串噪音）。
  assert.equal(docs[1]!.publication_date, undefined);
  assert.equal(docs[1]!.title, "示例专利");
  assert.equal(docs[1]!.snippet, "摘要");
  assert.equal(docs[1]!.url, "https://patents.google.com/patent/CN1234567A");
});

test("searchProvider: 无公开日字段的旧命中不报错、不降级", async () => {
  const provider = createNuoSearchProvider({
    search: async () => ({
      query: "q",
      total: 1,
      warnings: [],
      hits: [
        { patent: "US1", title: "Old", assignee: "", publication_date: "", priority_date: "", abstract: "a", url: "u" },
      ],
    }),
  });
  const docs = await provider.search!("old query");
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.publication_date, undefined);
});

const sourceDoc = (url: string, title: string) => ({ title, snippet: "s", url, publication_date: "2020-01-01" });

test("multiSource: 多源并行（两个源同时在飞，非串行）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const barrier = new Promise<void>(resolve => setTimeout(resolve, 30));
  const makeSource = () => async (): Promise<Array<ReturnType<typeof sourceDoc>>> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await barrier;
    inFlight -= 1;
    return [sourceDoc("u", "t")];
  };
  const provider = createMultiSourceSearchProvider([makeSource(), makeSource()]);
  const docs = await provider.search!("q");
  assert.equal(docs.length, 1);
  // 串行实现下 maxInFlight 只会是 1；并行实现应达到 2。
  assert.equal(maxInFlight, 2);
});

test("multiSource: 按 url 去重（跨源重复命中只保留一条）", async () => {
  const a = async () => [sourceDoc("https://x/patent/1", "Patent A")];
  const b = async () => [sourceDoc("https://x/patent/1", "Patent A 重复"), sourceDoc("https://x/patent/2", "Patent B")];
  const provider = createMultiSourceSearchProvider([a, b]);
  const docs = await provider.search!("q", { maxResults: 10 });
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map(d => d.url).sort(), ["https://x/patent/1", "https://x/patent/2"]);
});

test("multiSource: 无 url 命中按 title 回退去重", async () => {
  const a = async () => [{ title: "同题", snippet: "s1" }];
  const b = async () => [
    { title: "同题", snippet: "s2" },
    { title: "另一篇", snippet: "s3" },
  ];
  const provider = createMultiSourceSearchProvider([a, b]);
  const docs = await provider.search!("q", { maxResults: 10 });
  assert.equal(docs.length, 2);
  assert.deepEqual(
    docs.map(d => d.title),
    ["同题", "另一篇"],
  );
});

test("multiSource: 单源失败 fail-open（其他源结果保留）", async () => {
  const ok = async () => [sourceDoc("https://x/ok", "OK")];
  const failing = async () => {
    throw new Error("source down");
  };
  const provider = createMultiSourceSearchProvider([ok, failing]);
  const docs = await provider.search!("q");
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.title, "OK");
});

test("multiSource: maxResults 截断合并结果", async () => {
  const a = async () => [sourceDoc("https://x/1", "A1"), sourceDoc("https://x/2", "A2")];
  const b = async () => [sourceDoc("https://x/3", "B1"), sourceDoc("https://x/4", "B2")];
  const provider = createMultiSourceSearchProvider([a, b]);
  const docs = await provider.search!("q", { maxResults: 3 });
  assert.equal(docs.length, 3);
});

function mockConnector(id: string, hits: ConnectorHit[]): Connector {
  return {
    id,
    name: id,
    domain: "literature",
    description: "mock connector",
    search: async () => hits,
  };
}

test("paperSource: 并行检索全部 connector 并归一化命中形状", async () => {
  const registry = new ConnectorRegistry();
  registry.register(
    mockConnector("arxiv", [{ id: "a1", title: "Paper A", summary: "summary A", url: "https://arxiv.org/a1" }]),
  );
  registry.register(
    mockConnector("openalex", [{ id: "o1", title: "Paper O", summary: undefined, url: "https://openalex.org/o1" }]),
  );
  const source = createPaperSearchSource(registry);
  const docs = await source("检索策略：分拣 AND 传感器", { maxResults: 5 });
  assert.equal(docs.length, 2);
  assert.deepEqual(
    docs.map(d => ({ title: d.title, snippet: d.snippet, url: d.url })),
    [
      { title: "Paper A", snippet: "summary A", url: "https://arxiv.org/a1" },
      { title: "Paper O", snippet: "", url: "https://openalex.org/o1" },
    ],
  );
  assert.equal(docs[0]!.publication_date, undefined);
});

test("paperSource: 单 connector 失败 fail-open（其余源结果保留）", async () => {
  const registry = new ConnectorRegistry();
  registry.register(mockConnector("arxiv", [{ id: "a1", title: "Paper A", url: "https://arxiv.org/a1" }]));
  registry.register({
    id: "broken",
    name: "broken",
    domain: "literature",
    description: "broken",
    search: async () => {
      throw new Error("down");
    },
  });
  const source = createPaperSearchSource(registry);
  const docs = await source("q", { maxResults: 5 });
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.title, "Paper A");
});

test("paperSource: 同一论文多库收录按归一化 title 去重（url 跨源不同不判重）", async () => {
  const registry = new ConnectorRegistry();
  registry.register(
    mockConnector("arxiv", [{ id: "a1", title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762" }]),
  );
  registry.register(
    mockConnector("crossref", [{ id: "c1", title: "Attention Is All You Need", url: "https://doi.org/10.5555/123" }]),
  );
  registry.register(mockConnector("openalex", [{ id: "o1", title: "Another Paper", url: "https://openalex.org/o1" }]));
  const source = createPaperSearchSource(registry);
  const docs = await source("transformer attention", { maxResults: 10 });
  assert.equal(docs.length, 2);
  assert.deepEqual(
    docs.map(d => d.title),
    ["Attention Is All You Need", "Another Paper"],
  );
});

// ---------------------------------------------------------------------------
// #710：JSON 主路径（ego outerHTML 解包 + PARSE_ERROR 判定）
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/patent-search");
const readFixture = (name: string): string => readFileSync(resolve(FIXTURE_DIR, name), "utf8");

function makeVendorResult(overrides: Partial<PatentSearchResult> = {}): PatentSearchResult {
  return { query: "q", total: 0, hits: [], warnings: [], ...overrides };
}

test("decodeHtmlEntities: 命名实体与数字实体", () => {
  assert.equal(decodeHtmlEntities("a&amp;b&lt;c&gt;d&quot;e&#39;f&#x2F;g"), "a&b<c>d\"e'f/g");
});

test("extractJsonText: <pre> 包裹的 JSON 可解包并解码实体", () => {
  const parsed = JSON.parse(extractJsonText(readFixture("xhr-html-wrapper.html"))) as {
    results: { total_num_results: number };
  };
  assert.equal(parsed.results.total_num_results, 1);
});

test("extractJsonText: 裸 JSON 原样返回；非 JSON 页面抛错", () => {
  assert.equal(extractJsonText('{"results":{}}'), '{"results":{}}');
  assert.throws(() => extractJsonText("<html><body>captcha</body></html>"), /不是 JSON/);
});

test("buildGooglePatentsXhrUrl: 编码查询并把 limit 夹到 1-50", () => {
  const url = buildGooglePatentsXhrUrl("phase change", 999);
  assert.equal(url.includes("num=50"), true);
  assert.equal(url.includes("q%3Dphase%20change"), true);
  assert.equal(buildGooglePatentsXhrUrl("x", 0).includes("num=1"), true);
});

test("withEgoJsonSearch: ego JSON 命中后不再调用 vendor", async () => {
  let vendorCalls = 0;
  const search = withEgoJsonSearch(
    async () => {
      vendorCalls += 1;
      return makeVendorResult();
    },
    { fetchText: async () => readFixture("xhr-phase-change.json") },
  );
  const result = await search("phase change", { limit: 5 });
  assert.equal(result.dataSource, "ego-json");
  assert.equal(result.total, 1284);
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0]!.assignee, "华为技术有限公司");
  assert.equal(vendorCalls, 0);
});

test("withEgoJsonSearch: 真实 XHR fixture 均可命中（4 关键词 + 2 公开号）", async () => {
  const fixtures: Array<[string, number]> = [
    ["real-01-phase-change.json", 123547],
    ["real-02-cn-thermal.json", 77907],
    ["real-03-assignee.json", 35615],
    ["real-04-thermal.json", 123172],
    ["real-05-publication.json", 1],
    ["real-06-publication-2.json", 1],
  ];
  for (const [name, expectedTotal] of fixtures) {
    const search = withEgoJsonSearch(async () => makeVendorResult(), {
      fetchText: async () => readFixture(name),
    });
    const result = await search("fixture query", { limit: 3 });
    assert.equal(result.dataSource, "ego-json", name);
    assert.equal(result.total, expectedTotal, name);
    assert.ok(result.hits.length >= 1, `${name} 应至少 1 条命中`);
    assert.ok(result.hits.length <= 3, `${name} 应遵守 limit`);
  }
});

test("withEgoJsonSearch: Google 忽略 num 时仍按 limit 截断", async () => {
  const search = withEgoJsonSearch(async () => makeVendorResult(), {
    fetchText: async () => readFixture("xhr-phase-change.json"),
  });
  const result = await search("phase change", { limit: 1 });
  assert.equal(result.hits.length, 1);
  assert.equal(result.total, 1284);
});

test("withEgoJsonSearch: 解包 ego outerHTML 中的 <pre> JSON", async () => {
  const search = withEgoJsonSearch(async () => makeVendorResult(), {
    fetchText: async () => readFixture("xhr-html-wrapper.html"),
  });
  const result = await search("thermal", {});
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.title, "Thermal & management system");
});

test("withEgoJsonSearch: total=0 判定真实零命中（不回退 vendor）", async () => {
  let vendorCalls = 0;
  const search = withEgoJsonSearch(
    async () => {
      vendorCalls += 1;
      return makeVendorResult();
    },
    { fetchText: async () => readFixture("xhr-zero.json") },
  );
  const result = await search("zzz nonexistent", {});
  assert.equal(result.dataSource, "ego-json");
  assert.equal(result.hits.length, 0);
  assert.equal(
    result.warnings.some(w => w.includes("无命中")),
    true,
  );
  assert.equal(vendorCalls, 0);
});

test("withEgoJsonSearch: total>0 但 0 条命中 → PARSE_ERROR（不冒充 0 命中）", async () => {
  let vendorCalls = 0;
  const search = withEgoJsonSearch(
    async () => {
      vendorCalls += 1;
      return makeVendorResult({ warnings: ["搜索结果页未解析到任何结果（页面结构可能变化）"] });
    },
    { fetchText: async () => '{"results":{"total_num_results":42,"cluster":[]}}' },
  );
  const result = await search("q", {});
  assert.equal(result.warnings[0]!.startsWith("PARSE_ERROR"), true);
  assert.equal(result.dataSource, "vendor");
  assert.equal(vendorCalls, 1);
});

test("withEgoJsonSearch: JSON 抓取失败但 vendor 有命中 → 保留命中并标注回退", async () => {
  const search = withEgoJsonSearch(async () => makeVendorResult({ total: 1, hits: [hit()] }), {
    fetchText: async () => {
      throw new Error("ego down");
    },
  });
  const result = await search("q", {});
  assert.equal(result.dataSource, "vendor");
  assert.equal(result.hits.length, 1);
  assert.equal(
    result.warnings.some(w => w.includes("已回退 vendor")),
    true,
  );
});

test("withEgoJsonSearch: 两路都解析失败 → PARSE_ERROR", async () => {
  const search = withEgoJsonSearch(
    async () => makeVendorResult({ warnings: ["搜索结果页未解析到任何结果（页面结构可能变化）"] }),
    {
      fetchText: async () => {
        throw new Error("ego down");
      },
    },
  );
  const result = await search("q", {});
  assert.equal(result.warnings[0]!.startsWith("PARSE_ERROR"), true);
});

test("withEgoJsonSearch: ego 不可用时走原生 fetch JSON", async () => {
  const search = withEgoJsonSearch(async () => makeVendorResult(), {
    egoAvailable: () => false,
    fetchImpl: async () => new Response(readFixture("xhr-phase-change.json"), { status: 200 }),
  });
  const result = await search("phase change", {});
  assert.equal(result.dataSource, "native-json");
  assert.equal(result.hits.length, 2);
});

test("withEgoJsonSearch: 中止信号 → 请求已被取消（不静默 0 命中）", async () => {
  const controller = new AbortController();
  controller.abort();
  const search = withEgoJsonSearch(async () => makeVendorResult(), {
    fetchText: async () => {
      throw new Error("aborted");
    },
  });
  const result = await search("q", { signal: controller.signal });
  assert.deepEqual(result.warnings, ["请求已被取消"]);
});

test("withEgoJsonSearch: enabled=false 直接走 vendor", async () => {
  const search = withEgoJsonSearch(async () => makeVendorResult({ total: 1, hits: [hit()] }), { enabled: false });
  const result = await search("q", {});
  assert.equal(result.dataSource, "vendor");
  assert.equal(result.hits.length, 1);
});
