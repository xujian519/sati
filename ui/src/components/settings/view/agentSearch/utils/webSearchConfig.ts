import type { SatiConfig } from "../../modelPool/types";

/**
 * provider 清单与端点表的事实源在 `src/pilot/config/webSearchProviders.ts`。
 * 前端（浏览器侧）不能 import src，故此处单列一份；两侧漂移由后端的 YAML 校验
 * （parseToolsConfig 用同一份枚举）兜住——写了后端不认的 provider 会在保存时
 * 直接报错，而不是静默落盘。
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

/** SerpAPI 的 `engine` 取值（该 provider 是聚合器，需指定底层搜索引擎）。 */
export const SERPAPI_ENGINES = ["google", "bing", "baidu", "duckduckgo", "yahoo", "yandex"] as const;
export type SerpApiEngine = (typeof SERPAPI_ENGINES)[number];

export function isSerpApiEngine(value: unknown): value is SerpApiEngine {
  return typeof value === "string" && (SERPAPI_ENGINES as readonly string[]).includes(value);
}

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

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === "string" && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

type WebSearchConfig = NonNullable<NonNullable<SatiConfig["tools"]>["webSearch"]>;

export function webSearchConfigForProvider(
  current: WebSearchConfig,
  provider: WebSearchProvider,
  glmDefaultEndpoint: string,
): WebSearchConfig {
  return {
    ...(current.enabled === undefined ? {} : { enabled: current.enabled }),
    provider,
    ...(provider === "glm" ? { endpoint: glmDefaultEndpoint } : {}),
  };
}

export function isWebSearchApiKeyRequired(config: WebSearchConfig): boolean {
  const provider = isWebSearchProvider(config.provider) ? config.provider : "glm";
  return provider !== "custom" || (config.customProvider?.auth ?? "bearer") !== "none";
}
