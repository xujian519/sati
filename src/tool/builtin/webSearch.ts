import type { PermissionResult } from "../../permission/index.js";
import {
  WEB_SEARCH_ENDPOINTS,
  WEB_SEARCH_PROVIDERS,
  type SerpApiEngine,
  type WebSearchProvider,
} from "../../pilot/config/webSearchProviders.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolAvailabilityContext, SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import { isAdditionalSearchProvider, type WebSearchOrganicResult } from "../../pilot/config/webSearchAdapter.js";
import {
  performAdditionalSearch,
  performCustomSearch,
  performGlmSearch,
  performTavilySearch,
} from "./webSearchPerformers.js";
/**
 * `web_search` is a local Sati tool backed by exactly one configured
 * provider. The model still sees one stable tool surface; provider-specific
 * request/response shapes stay behind this adapter.
 *
 * provider 清单、端点表与文档链接见 `pilot/config/webSearchProviders.ts`
 * （YAML 校验与设置页共用同一份，避免枚举漂移）。
 */
export type { WebSearchProvider };
export type WebSearchCustomAuth = "bearer" | "bodyApiKey" | "queryApiKey" | "none";
export type WebSearchCustomMethod = "GET" | "POST";

export type WebSearchCustomProviderConfig = {
  name?: string;
  auth?: WebSearchCustomAuth;
  method?: WebSearchCustomMethod;
  queryParam?: string;
  apiKeyParam?: string;
  resultsPath?: string;
  titleField?: string;
  urlField?: string;
  snippetField?: string;
  sourceField?: string;
  publishedAtField?: string;
};

export type CreateWebSearchToolOptions = {
  provider?: WebSearchProvider;
  apiKey?: string;
  /** serpapi 专用：底层搜索引擎（缺省 google）。 */
  searchEngine?: SerpApiEngine;
  /** Override provider endpoint. 缺省取 webSearchProviders.ts 的端点表。 */
  endpoint?: string;
  customProvider?: WebSearchCustomProviderConfig;
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Override timeout (default 30s). */
  timeoutMs?: number;
  /** Cap on organic results returned to the model (default 8). */
  organicLimit?: number;
  /** Cap on top-stories returned (default 5). */
  topStoriesLimit?: number;
};

export type WebSearchInput = {
  /** Search query string. */
  query: string;
  /** Country code for localized results (default "us"). Use "cn" for China-localized results. */
  gl?: string;
};

export type { WebSearchOrganicResult };

export type WebSearchOutput = {
  query: string;
  organic: WebSearchOrganicResult[];
  knowledgeGraph?: Record<string, unknown>;
  answerBox?: Record<string, unknown>;
  topStories?: Array<Record<string, unknown>>;
};

const DEFAULT_GLM_ENDPOINT = "https://api.z.ai/api/paas/v4/web_search";
const DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ORGANIC_LIMIT = 8;

export function createWebSearchTool(
  options: CreateWebSearchToolOptions = {},
): SatiToolDefinition<WebSearchInput, WebSearchOutput> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const organicLimit = options.organicLimit ?? DEFAULT_ORGANIC_LIMIT;

  return {
    name: "web_search",
    outputSchema: {
      type: "object",
      required: ["query", "organic"],
      properties: {
        query: { type: "string" },
        organic: { type: "array" },
        answerBox: { type: "object", properties: { answer: { type: "string" } } },
      },
    },
    aliases: ["WebSearch"],
    description: `- **Recommended general web search tool.** Backed by a cloud search API, returns real results in ~1-3 seconds with structured organic results. Prefer this tool over locally-provided meta-search tools (e.g. MCP \`web_search\` backed by a local SearXNG instance), whose general web engines may be unavailable or slow.
- Searches the web for current information using the configured search provider
- Takes a search query and optional country code (\`gl\`) as input
- Returns structured search data including organic results and, when available, answer box content
- Use this tool for current events, recent documentation, and information beyond the model's knowledge cutoff
- Use this tool when API/SDK/framework usage is unknown, version-sensitive, or likely changed since training. Search with package/service name, version, framework, and the specific method/option/error.

Usage notes:
  - Configure \`tools.webSearch.provider\` in \`sati.yaml\` as one of \`glm\`, \`tavily\`, \`serper\`, \`brave\`, \`baidu\`, \`bocha\`, \`exa\`, \`serpapi\`, or \`custom\`
  - Requires \`tools.webSearch.apiKey\`, the provider's API key environment variable, or \`CUSTOM_WEB_SEARCH_API_KEY\` unless custom auth is \`none\`
  - The optional \`gl\` parameter is forwarded only by providers that support localization
  - This tool is read-only and does not modify files`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Search query string. Be specific, and include versions or the current year when looking for recent documentation, releases, or current events.",
        },
        gl: {
          type: "string",
          description:
            'Optional country code for localized results. Defaults to "us"; use "cn" for China-localized results.',
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkAvailability: context => checkWebSearchAvailability(options, context),
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "web_search",
        message: "Network search requires permission.",
      },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "web search",
        reason: {
          type: "tool",
          toolName: "web_search",
          message: "Network search requires permission.",
        },
        options: [
          { id: "allow_once", label: "Allow search" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const provider = resolveProvider(options.provider, options.apiKey, context);
      const apiKey = resolveApiKey(options.apiKey, provider, context);
      const custom = normalizeCustomProviderConfig(options.customProvider);
      if (!apiKey && !(provider === "custom" && custom.auth === "none")) {
        throw new SatiToolRuntimeError(
          "setup_required",
          "web_search requires an API key. Please configure it in Settings → Search.",
          { tool: "web_search" },
        );
      }
      if (provider === "custom") {
        if (!options.endpoint?.trim()) {
          throw new SatiToolRuntimeError(
            "setup_required",
            "web_search custom provider requires an endpoint URL. Please configure it in Settings → Search.",
            { tool: "web_search" },
          );
        }
        return performCustomSearch({
          input,
          context,
          apiKey: apiKey ?? "",
          endpoint: options.endpoint,
          fetchImpl,
          timeoutMs,
          organicLimit,
          custom,
        });
      }
      if (isAdditionalSearchProvider(provider)) {
        return performAdditionalSearch({
          input,
          context,
          apiKey: apiKey ?? "",
          provider,
          endpoint: options.endpoint ?? WEB_SEARCH_ENDPOINTS[provider],
          searchEngine: options.searchEngine,
          fetchImpl,
          timeoutMs,
          organicLimit,
        });
      }
      if (provider === "tavily") {
        return performTavilySearch({
          input,
          context,
          apiKey: apiKey ?? "",
          endpoint: options.endpoint ?? DEFAULT_TAVILY_ENDPOINT,
          fetchImpl,
          timeoutMs,
          organicLimit,
        });
      }
      return performGlmSearch({
        input,
        context,
        apiKey: apiKey ?? "",
        endpoint: options.endpoint ?? readEnv(context, "GLM_WEB_SEARCH_ENDPOINT") ?? DEFAULT_GLM_ENDPOINT,
        fetchImpl,
        timeoutMs,
        organicLimit,
      });
    },
  };
}

function checkWebSearchAvailability(options: CreateWebSearchToolOptions, context: SatiToolAvailabilityContext) {
  const runtimeContext = {
    cwd: context.cwd,
    env: context.env,
  } as SatiToolRuntimeContext;
  const provider = resolveProvider(options.provider, options.apiKey, runtimeContext);
  const apiKey = resolveApiKey(options.apiKey, provider, runtimeContext);
  const custom = normalizeCustomProviderConfig(options.customProvider);

  if (!apiKey && !(provider === "custom" && custom.auth === "none")) {
    return {
      ok: false as const,
      code: "setup_required" as const,
      reason: "web_search requires an API key.",
    };
  }
  if (provider === "custom" && !options.endpoint?.trim()) {
    return {
      ok: false as const,
      code: "setup_required" as const,
      reason: "web_search custom provider requires an endpoint URL.",
    };
  }

  return { ok: true as const };
}

/**
 * provider → 该 provider 的 API key 环境变量（按优先级）。
 * `resolveProvider`（无显式配置时按 key 推断）与 `resolveApiKey` 共用同一张表，
 * 避免两处各写一份映射后漂移。
 */
const PROVIDER_API_KEY_ENV: Partial<Record<WebSearchProvider, string[]>> = {
  glm: ["GLM_WEB_SEARCH_API_KEY", "ZAI_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  serper: ["SERPER_API_KEY"],
  brave: ["BRAVE_API_KEY"],
  baidu: ["BAIDU_WEB_SEARCH_API_KEY"],
  bocha: ["BOCHA_API_KEY"],
  exa: ["EXA_API_KEY"],
  serpapi: ["SERPAPI_API_KEY"],
  custom: ["CUSTOM_WEB_SEARCH_API_KEY"],
};

function resolveProvider(
  optionProvider: WebSearchProvider | undefined,
  optionApiKey: string | undefined,
  context: SatiToolRuntimeContext,
): WebSearchProvider {
  if (optionProvider) return optionProvider;
  if (optionApiKey?.trim()) return "glm";
  // 无显式配置时按环境变量推断（GLM 是兜底默认，custom 必须显式配置端点，故二者不参与探测）。
  for (const provider of WEB_SEARCH_PROVIDERS) {
    if (provider === "glm" || provider === "custom") continue;
    if ((PROVIDER_API_KEY_ENV[provider] ?? []).some(name => readEnv(context, name))) return provider;
  }
  return "glm";
}

function resolveApiKey(
  optionApiKey: string | undefined,
  provider: WebSearchProvider,
  context: SatiToolRuntimeContext,
): string | undefined {
  const fromOption = optionApiKey?.trim();
  if (fromOption) {
    return fromOption;
  }
  for (const name of PROVIDER_API_KEY_ENV[provider] ?? []) {
    const value = readEnv(context, name);
    if (value) return value;
  }
  return undefined;
}

function normalizeCustomProviderConfig(
  config: WebSearchCustomProviderConfig | undefined,
): Required<WebSearchCustomProviderConfig> {
  return {
    auth: config?.auth ?? "bearer",
    name: config?.name?.trim() || "custom",
    method: config?.method ?? "POST",
    queryParam: config?.queryParam?.trim() || "query",
    apiKeyParam: config?.apiKeyParam?.trim() || "api_key",
    resultsPath: config?.resultsPath?.trim() || "",
    titleField: config?.titleField?.trim() || "title",
    urlField: config?.urlField?.trim() || "url",
    snippetField: config?.snippetField?.trim() || "snippet",
    sourceField: config?.sourceField?.trim() || "source",
    publishedAtField: config?.publishedAtField?.trim() || "publishedAt",
  };
}

function readEnv(context: SatiToolRuntimeContext, name: string): string | undefined {
  const value = (context.env ?? process.env)[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}
