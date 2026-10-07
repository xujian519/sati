import assert from "node:assert/strict";
import test from "node:test";
import {
  additionalSearchRequest,
  additionalSearchResults,
  isAdditionalSearchProvider,
  redactSearchError,
} from "../../../src/pilot/config/webSearchAdapter.js";

const asHeaders = (init: RequestInit): Record<string, string> => (init.headers ?? {}) as Record<string, string>;

// ─── provider 判定 ───────────────────────────────────────────────────────────

test("isAdditionalSearchProvider covers the six supplementary providers only", () => {
  for (const provider of ["baidu", "bocha", "exa", "serpapi", "serper", "brave"]) {
    assert.equal(isAdditionalSearchProvider(provider), true);
  }
  for (const provider of ["glm", "tavily", "custom", "nope"]) {
    assert.equal(isAdditionalSearchProvider(provider), false);
  }
});

// ─── 请求构造 ────────────────────────────────────────────────────────────────

test("additionalSearchRequest sends Baidu a Bearer-authenticated JSON POST", () => {
  const { url, init } = additionalSearchRequest("baidu", {
    endpoint: "https://qianfan.baidubce.com/v2/ai_search/web_search",
    apiKey: "bd-key",
    query: "专利 检索",
    limit: 5,
  });

  assert.equal(url, "https://qianfan.baidubce.com/v2/ai_search/web_search");
  assert.equal(init.method, "POST");
  assert.equal(asHeaders(init).Authorization, "Bearer bd-key");
  const body = JSON.parse(String(init.body));
  assert.equal(body.search_source, "baidu_search_v2");
  assert.deepEqual(body.resource_type_filter, [{ type: "web", top_k: 5 }]);
  assert.deepEqual(body.messages, [{ role: "user", content: "专利 检索" }]);
});

test("additionalSearchRequest sends Bocha a Bearer-authenticated JSON POST with count", () => {
  const { init } = additionalSearchRequest("bocha", {
    endpoint: "https://api.bocha.cn/v1/web-search",
    apiKey: "bo-key",
    query: "检索",
    limit: 3,
  });

  assert.equal(init.method, "POST");
  assert.equal(asHeaders(init).Authorization, "Bearer bo-key");
  assert.deepEqual(JSON.parse(String(init.body)), {
    query: "检索",
    count: 3,
    freshness: "noLimit",
    summary: true,
  });
});

test("additionalSearchRequest sends Exa the key in an x-api-key header", () => {
  const { init } = additionalSearchRequest("exa", {
    endpoint: "https://api.exa.ai/search",
    apiKey: "exa-key",
    query: "quantum",
    limit: 4,
  });

  assert.equal(asHeaders(init)["x-api-key"], "exa-key");
  assert.equal(asHeaders(init).Authorization, undefined);
  assert.equal(JSON.parse(String(init.body)).numResults, 4);
});

test("additionalSearchRequest puts the SerpAPI key and engine in the query string", () => {
  const { url, init } = additionalSearchRequest("serpapi", {
    endpoint: "https://serpapi.com/search.json",
    apiKey: "sp-key",
    query: "quantum",
    limit: 10,
    searchEngine: "baidu",
  });

  const parsed = new URL(url);
  assert.equal(init.method, "GET");
  assert.equal(parsed.searchParams.get("engine"), "baidu");
  assert.equal(parsed.searchParams.get("q"), "quantum");
  assert.equal(parsed.searchParams.get("api_key"), "sp-key");
});

test("additionalSearchRequest uses the p/text parameter for yahoo and yandex engines", () => {
  const yahoo = new URL(
    additionalSearchRequest("serpapi", {
      endpoint: "https://serpapi.com/search.json",
      apiKey: "k",
      query: "q",
      limit: 1,
      searchEngine: "yahoo",
    }).url,
  );
  const yandex = new URL(
    additionalSearchRequest("serpapi", {
      endpoint: "https://serpapi.com/search.json",
      apiKey: "k",
      query: "q",
      limit: 1,
      searchEngine: "yandex",
    }).url,
  );

  assert.equal(yahoo.searchParams.get("p"), "q");
  assert.equal(yahoo.searchParams.get("q"), null);
  assert.equal(yandex.searchParams.get("text"), "q");
  assert.equal(yandex.searchParams.get("q"), null);
});

test("additionalSearchRequest sends Serper a POST with the key in an X-API-KEY header", () => {
  // 回归防护：serper 曾无执行分支，穿透到 webSearch.ts 末尾的 GLM 兜底，
  // 把 SERPER_API_KEY 当 GLM token 以 Bearer 发到 api.z.ai。
  const { url, init } = additionalSearchRequest("serper", {
    endpoint: "https://google.serper.dev/search",
    apiKey: "serper-key",
    query: "quantum",
    limit: 7,
  });

  assert.equal(url, "https://google.serper.dev/search");
  assert.equal(init.method, "POST");
  assert.equal(asHeaders(init)["X-API-KEY"], "serper-key");
  assert.equal(asHeaders(init).Authorization, undefined);
  assert.deepEqual(JSON.parse(String(init.body)), { q: "quantum", num: 7 });
});

test("additionalSearchRequest sends Brave a GET with the key in X-Subscription-Token", () => {
  const { url, init } = additionalSearchRequest("brave", {
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    apiKey: "brave-key",
    query: "专利 检索",
    limit: 5,
  });

  const parsed = new URL(url);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(asHeaders(init)["X-Subscription-Token"], "brave-key");
  assert.equal(asHeaders(init).Authorization, undefined);
  // 密钥不进 URL：Brave 走头部认证，故网络错误无需脱敏。
  assert.equal(url.includes("brave-key"), false);
  assert.equal(parsed.searchParams.get("q"), "专利 检索");
  assert.equal(parsed.searchParams.get("count"), "5");
});

test("additionalSearchRequest clamps each provider's result limit to its own ceiling", () => {
  const body = (provider: "bocha" | "serper", limit: number) =>
    JSON.parse(
      String(
        additionalSearchRequest(provider, {
          endpoint: provider === "bocha" ? "https://api.bocha.cn/v1/web-search" : "https://google.serper.dev/search",
          apiKey: "k",
          query: "q",
          limit,
        }).init.body,
      ),
    );
  const braveCount = (limit: number) =>
    new URL(
      additionalSearchRequest("brave", {
        endpoint: "https://api.search.brave.com/res/v1/web/search",
        apiKey: "k",
        query: "q",
        limit,
      }).url,
    ).searchParams.get("count");

  assert.equal(body("bocha", 0).count, 1);
  assert.equal(body("bocha", 999).count, 50);
  assert.equal(body("bocha", 7.9).count, 7);
  // Serper 的服务端上限（100）高于通用夹取上限（50），故通用夹取即最终值。
  assert.equal(body("serper", 999).num, 50);
  // Brave 的服务端上限是 20，比通用上限更紧，超出会 422，故单独再夹一道。
  assert.equal(braveCount(999), "20");
  assert.equal(braveCount(0), "1");
});

test("additionalSearchRequest rejects a non-HTTP endpoint", () => {
  for (const endpoint of ["file:///etc/passwd", "ftp://example.test/search"]) {
    assert.throws(() => additionalSearchRequest("exa", { endpoint, apiKey: "k", query: "q", limit: 5 }), /HTTP\(S\)/);
  }
});

// ─── 响应归一化 ──────────────────────────────────────────────────────────────

test("additionalSearchResults normalizes Baidu references and drops non-web entries", () => {
  const results = additionalSearchResults(
    "baidu",
    {
      references: [
        { title: "A", url: "https://a.test", summary: "sa", siteName: "A站", date: "2026-01-01" },
        { title: "IMG", url: "https://i.test", type: "image" },
      ],
    },
    8,
  );

  assert.deepEqual(results, [
    { title: "A", link: "https://a.test", snippet: "sa", source: "A站", publishedAt: "2026-01-01" },
  ]);
});

test("additionalSearchResults unwraps Bocha's data.webPages.value and accepts a 200 code", () => {
  const results = additionalSearchResults(
    "bocha",
    { code: 200, data: { webPages: { value: [{ name: "B", url: "https://b.test", snippet: "sb" }] } } },
    8,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "B");
  assert.equal(results[0].link, "https://b.test");
});

test("additionalSearchResults joins Exa highlights when there is no snippet", () => {
  const results = additionalSearchResults(
    "exa",
    { results: [{ title: "E", url: "https://e.test", highlights: ["first", "second"] }] },
    8,
  );

  assert.equal(results[0].snippet, "first\nsecond");
});

test("additionalSearchResults returns an empty list for a SerpAPI query with no organic hits", () => {
  // SerpAPI 对"没有自然结果"的查询合法地省略 organic_results —— 这不是错误。
  assert.deepEqual(additionalSearchResults("serpapi", { search_metadata: { status: "Success" } }, 8), []);
});

test("additionalSearchResults normalizes Serper's organic list", () => {
  const results = additionalSearchResults(
    "serper",
    { organic: [{ title: "S", link: "https://s.test", snippet: "ss", date: "2026-02-02" }] },
    8,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "S");
  assert.equal(results[0].link, "https://s.test");
  assert.equal(results[0].snippet, "ss");
  assert.equal(results[0].publishedAt, "2026-02-02");
});

test("additionalSearchResults unwraps Brave's web.results and tolerates a missing web block", () => {
  const results = additionalSearchResults(
    "brave",
    { web: { results: [{ title: "B", url: "https://b.test", description: "db" }] } },
    8,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "B");
  assert.equal(results[0].link, "https://b.test");
  assert.equal(results[0].snippet, "db");

  // Brave 对"没有结果"的查询会整个省略 `web` 块，与 SerpAPI 省略 organic_results 同理。
  assert.deepEqual(additionalSearchResults("brave", { query: { original: "x" } }, 8), []);
});

test("additionalSearchResults throws when the result list is missing for other providers", () => {
  assert.throws(() => additionalSearchResults("exa", { results: undefined }, 8), /missing its result list/);
});

test("additionalSearchResults throws on a provider error code or payload", () => {
  assert.throws(() => additionalSearchResults("baidu", { code: 1001, message: "bad key" }, 8), /bad key/);
  assert.throws(() => additionalSearchResults("serpapi", { error: "invalid api key" }, 8), /invalid api key/);
  assert.throws(
    () => additionalSearchResults("serpapi", { search_metadata: { status: "Error" } }, 8),
    /SerpAPI search failed/,
  );
});

test("additionalSearchResults applies the limit after filtering", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ title: `t${index}`, url: `https://x.test/${index}` }));
  assert.equal(additionalSearchResults("exa", { results: items }, 3).length, 3);
});

// ─── 密钥脱敏 ────────────────────────────────────────────────────────────────

test("redactSearchError removes the api key in plain, encoded and query form", () => {
  const key = "sk-ab/c+d";
  const encoded = encodeURIComponent(key);
  const message = `GET https://serpapi.com/search.json?api_key=${key}&x=1 failed (also ${encoded})`;

  const redacted = redactSearchError(new Error(message), key);

  assert.equal(redacted.includes(key), false);
  assert.equal(redacted.includes(encoded), false);
  assert.equal(redacted.includes("[redacted]"), true);
});

test("redactSearchError truncates a pathological provider error", () => {
  const redacted = redactSearchError(new Error("x".repeat(5000)), "k");
  assert.equal(redacted.length, 500);
});
