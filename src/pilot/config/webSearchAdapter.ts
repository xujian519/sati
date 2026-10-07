import { isSerpApiEngine, type SerpApiEngine } from "./webSearchProviders.js";

/**
 * `web_search` 各 provider 的请求形状与响应归一化。
 *
 * 放在 pilot/config 而非 tool/builtin：设置页的连通性探测（ui/server 的
 * `/test-web-search`）必须复用同一套认证方式与结果解析——否则会出现"设置页
 * 测通、实际搜索失败"。ui/server 只能经 `src/pilot/index.js` barrel 访问
 * src（见 scripts/check-ui-server-boundary.mjs 白名单），故该能力收在此层。
 *
 * 依赖方向：tool → pilot。此文件不反向依赖 tool。
 */

/** 归一化后的单条自然结果（`web_search` 的输出契约）。 */
export type WebSearchOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
};

/**
 * "补充" provider：baidu / bocha / exa / serpapi / serper / brave。
 *
 * 单工具对外形状不变（模型只看到 `web_search`），各家差异收在这里：
 * 请求构造（认证头与 body 各不同）与响应归一化（结果列表路径各不相同）。
 *
 * 这六家之外只剩 glm / tavily / custom 三个内联分支。新增 provider 必须落在
 * 本联合里——漏掉会让它穿透到 web_search.ts 末尾的 glm 兜底分支，把别家的
 * API key 当 GLM token 发到 Z.AI（见 tests/tool/builtin/webSearch.spec.ts 的
 * 「每个 provider 都有自己的执行分支」）。
 */
export type AdditionalSearchProvider = "baidu" | "bocha" | "exa" | "serpapi" | "serper" | "brave";

export function isAdditionalSearchProvider(value: unknown): value is AdditionalSearchProvider {
  return (
    value === "baidu" ||
    value === "bocha" ||
    value === "exa" ||
    value === "serpapi" ||
    value === "serper" ||
    value === "brave"
  );
}

/** 请求构造：工具实际搜索与设置页的连通性探测共用，避免两处各写一份认证方式。 */
export function additionalSearchRequest(
  provider: AdditionalSearchProvider,
  options: {
    endpoint: string;
    apiKey: string;
    query: string;
    limit: number;
    searchEngine?: SerpApiEngine;
    gl?: string;
  },
): { url: string; init: RequestInit } {
  const { endpoint, apiKey, query } = options;
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Search endpoint must use HTTP(S).");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit)));

  if (provider === "serpapi") {
    // 聚合器：用 GET + query 参数，engine 指定底层搜索引擎，key 也在 URL 上
    // （因此网络错误里的 URL 必须脱敏，见 redactSearchError）。
    const engine = options.searchEngine ?? "google";
    if (!isSerpApiEngine(engine)) throw new Error("Unsupported SerpAPI search engine.");
    url.searchParams.set("engine", engine);
    url.searchParams.set(engine === "yahoo" ? "p" : engine === "yandex" ? "text" : "q", query);
    url.searchParams.set("api_key", apiKey);
    if (engine === "google" && options.gl?.trim()) url.searchParams.set("gl", options.gl.trim());
    return { url: url.toString(), init: { method: "GET", headers } };
  }

  if (provider === "brave") {
    // Brave 是 GET + 头部认证，`count` 上限 20（超出由服务端截断，这里先夹住
    // 避免无谓的 422）。密钥不进 URL，故无需脱敏。
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.max(1, Math.min(20, limit))));
    headers["X-Subscription-Token"] = apiKey;
    return { url: url.toString(), init: { method: "GET", headers } };
  }

  headers["Content-Type"] = "application/json";
  let body: Record<string, unknown>;
  if (provider === "serper") {
    // Serper 是 POST JSON + `X-API-KEY`。`num` 的服务端上限是 100，高于上面的
    // 通用夹取上限（50），故此处无需再夹。
    headers["X-API-KEY"] = apiKey;
    body = { q: query, num: limit };
  } else if (provider === "baidu") {
    headers.Authorization = `Bearer ${apiKey}`;
    body = {
      messages: [{ role: "user", content: query }],
      search_source: "baidu_search_v2",
      resource_type_filter: [{ type: "web", top_k: limit }],
    };
  } else if (provider === "bocha") {
    headers.Authorization = `Bearer ${apiKey}`;
    body = { query, count: limit, freshness: "noLimit", summary: true };
  } else {
    headers["x-api-key"] = apiKey;
    body = { query, numResults: limit, type: "auto", contents: { highlights: true, text: false } };
  }
  return { url: url.toString(), init: { method: "POST", headers, body: JSON.stringify(body) } };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** 响应归一化：把六家的结果列表折成同一形状。 */
export function additionalSearchResults(
  provider: AdditionalSearchProvider,
  raw: unknown,
  limit: number,
): WebSearchOrganicResult[] {
  if (!record(raw)) throw new Error("Search API returned an invalid JSON response.");
  if (raw.error) throw new Error(typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error));

  const code = raw.code;
  if (code !== undefined && code !== 0 && code !== "0" && !(provider === "bocha" && (code === 200 || code === "200"))) {
    throw new Error(`code=${String(code)}: ${text(raw.message) ?? text(raw.msg) ?? "Search provider error"}`);
  }
  if (provider === "serpapi" && record(raw.search_metadata) && raw.search_metadata.status === "Error") {
    throw new Error("SerpAPI search failed.");
  }

  const data = provider === "bocha" && record(raw.data) ? raw.data : raw;
  const pages = record(data.webPages) ? data.webPages.value : undefined;
  const items =
    provider === "baidu"
      ? raw.references
      : provider === "bocha"
        ? pages
        : provider === "exa"
          ? raw.results
          : provider === "serper"
            ? raw.organic
            : provider === "brave"
              ? record(raw.web)
                ? raw.web.results
                : undefined
              : raw.organic_results;

  // SerpAPI 对"没有自然结果"的查询合法地省略 organic_results；Brave 同理会省略
  // 整个 `web` 块。二者此时返回空列表而非报错。（Serper 稳定给出 `organic: []`，
  // 缺失即视为异常响应，故不在宽免之列。）
  if (!Array.isArray(items)) {
    if (provider === "serpapi" && record(raw.search_metadata) && raw.search_metadata.status === "Success") {
      return [];
    }
    if (provider === "brave") return [];
    throw new Error("Search API response is missing its result list.");
  }

  return items
    .filter(record)
    .filter(item => provider !== "baidu" || !item.type || item.type === "web")
    .slice(0, Math.max(0, limit))
    .map(item => ({
      title: text(item.title) ?? text(item.name),
      link: text(item.url) ?? text(item.link),
      snippet:
        text(item.summary) ??
        text(item.snippet) ??
        text(item.content) ??
        // Brave 用 `description`；Exa 的 highlights 是数组，需拼成一段。
        text(item.description) ??
        (Array.isArray(item.highlights)
          ? item.highlights.filter(value => typeof value === "string").join("\n") || undefined
          : undefined) ??
        text(item.text),
      source: text(item.siteName) ?? text(item.source),
      publishedAt: text(item.publishedDate) ?? text(item.datePublished) ?? text(item.date),
    }));
}

/** 走 query 认证的 API 会把密钥放进 URL，错误信息里必须抹掉。 */
export function redactSearchError(value: unknown, apiKey: string): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of [apiKey, encodeURIComponent(apiKey), new URLSearchParams({ key: apiKey }).toString().slice(4)]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 500);
}
