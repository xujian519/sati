/**
 * `web_search` 的 provider 单一事实源：YAML 校验（parseToolsConfig）、工具实现
 * （tool/builtin/webSearch.ts）与设置页共用同一份 ID 与端点表，避免三处各写一份
 * 枚举后漂移（历史上设置页与后端校验就曾对不上）。
 */

export const WEB_SEARCH_PROVIDERS = [
  "glm",
  "tavily",
  "serper",
  "brave",
  "baidu",
  "bocha",
  "exa",
  "serpapi",
  "custom",
] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

/** SerpAPI 的 `engine` 参数取值（serpapi 是聚合器，需指定底层搜索引擎）。 */
export const SERPAPI_ENGINES = ["google", "bing", "baidu", "duckduckgo", "yahoo", "yandex"] as const;
export type SerpApiEngine = (typeof SERPAPI_ENGINES)[number];

export const WEB_SEARCH_ENDPOINTS: Record<Exclude<WebSearchProvider, "custom">, string> = {
  glm: "https://api.z.ai/api/paas/v4/web_search",
  tavily: "https://api.tavily.com/search",
  serper: "https://google.serper.dev/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  baidu: "https://qianfan.baidubce.com/v2/ai_search/web_search",
  bocha: "https://api.bocha.cn/v1/web-search",
  exa: "https://api.exa.ai/search",
  serpapi: "https://serpapi.com/search.json",
};

/** 各 provider 申请 API key 的文档入口（设置页展示用）。 */
export const WEB_SEARCH_DOCS: Record<Exclude<WebSearchProvider, "custom">, string> = {
  glm: "https://docs.z.ai/api-reference/tools/web-search",
  tavily: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  serper: "https://serper.dev/",
  brave: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started",
  baidu: "https://ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy",
  bocha: "https://github.com/Bocha-Labs/bocha-skills/tree/main/bocha-web-search",
  exa: "https://exa.ai/docs/reference/search",
  serpapi: "https://serpapi.com/search-api",
};

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === "string" && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

export function isSerpApiEngine(value: unknown): value is SerpApiEngine {
  return typeof value === "string" && (SERPAPI_ENGINES as readonly string[]).includes(value);
}
