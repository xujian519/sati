import { NetworkFetchError, networkFetch } from "../../network/fetch.js";
import {
  additionalSearchRequest,
  additionalSearchResults,
  type AdditionalSearchProvider,
  redactSearchError,
} from "../../pilot/config/webSearchAdapter.js";
import type { SerpApiEngine } from "../../pilot/config/webSearchProviders.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolExecutionOutput, SatiToolRuntimeContext } from "../protocol/types.js";
import type {
  WebSearchCustomProviderConfig,
  WebSearchInput,
  WebSearchOrganicResult,
  WebSearchOutput,
} from "./webSearch.js";

/**
 * `web_search` 各 provider 的执行实现与共用辅助。
 *
 * 从 webSearch.ts 拆出：该文件承载工具定义（schema / 权限 / 可用性）已接近
 * file-size 上限（800 行，见 scripts/check-architecture-boundaries.mjs R3），
 * 而 provider 实现只随 provider 数量增长，与工具契约无关。
 *
 * 依赖方向单向：webSearch.ts → 本文件；本文件只从 webSearch.ts 取类型。
 */
type PerformAdditionalSearchInput = {
  input: WebSearchInput;
  context: SatiToolRuntimeContext;
  apiKey: string;
  provider: AdditionalSearchProvider;
  endpoint: string;
  searchEngine?: SerpApiEngine;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
};

/**
 * 补充 provider（baidu / bocha / exa / serpapi）的执行路径。
 *
 * 错误信息一律过 `redactSearchError`：serpapi 走 query 认证，密钥就在 URL 上，
 * 网络层抛出的错误会把整条 URL 带出来。
 */
export async function performAdditionalSearch(
  args: PerformAdditionalSearchInput,
): Promise<SatiToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, provider, endpoint, searchEngine, fetchImpl, timeoutMs, organicLimit } = args;
  const query = input.query.trim();
  if (!query) {
    throw new SatiToolRuntimeError("invalid_tool_input", "web_search requires a non-empty `query`.");
  }

  let request: { url: string; init: RequestInit };
  try {
    request = additionalSearchRequest(provider, {
      endpoint,
      apiKey,
      query,
      limit: organicLimit,
      searchEngine,
      gl: input.gl,
    });
  } catch (error) {
    throw new SatiToolRuntimeError("invalid_tool_input", redactSearchError(error, apiKey), { tool: "web_search" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  let response: Response;
  try {
    response = await networkFetch(
      request.url,
      { ...request.init, signal: controller.signal },
      {
        timeoutMs,
        signal: controller.signal,
        fetchImpl,
        retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, retryOnPost: true },
      },
    );
  } catch (error) {
    if (isLocalTimeout(error, controller.signal, context.abortSignal)) {
      throw new SatiToolRuntimeError("tool_timeout", `web_search (${provider}) timed out after ${timeoutMs}ms.`);
    }
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `web_search (${provider}) request failed: ${redactSearchError(error, apiKey)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `${provider} search API error (${response.status}): ${redactSearchError(detail, apiKey)}`,
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `${provider} search API returned invalid JSON: ${redactSearchError(error, apiKey)}`,
    );
  }

  let organic: WebSearchOrganicResult[];
  try {
    organic = additionalSearchResults(provider, raw, organicLimit);
  } catch (error) {
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `${provider} search API error: ${redactSearchError(error, apiKey)}`,
    );
  }

  const output: WebSearchOutput = { query, organic };
  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider,
      endpoint,
      engine: provider,
      organicCount: organic.length,
    },
  };
}

type PerformTavilySearchInput = {
  input: WebSearchInput;
  context: SatiToolRuntimeContext;
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
};

export async function performTavilySearch(
  args: PerformTavilySearchInput,
): Promise<SatiToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, endpoint, fetchImpl, timeoutMs, organicLimit } = args;
  const query = input.query.trim();
  if (!query) {
    throw new SatiToolRuntimeError("invalid_tool_input", "web_search requires a non-empty `query`.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: organicLimit,
    include_answer: true,
    search_depth: "basic",
  };

  let response: Response;
  try {
    response = await networkFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      {
        timeoutMs,
        signal: controller.signal,
        fetchImpl,
        retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, retryOnPost: true },
      },
    );
  } catch (error) {
    if (isLocalTimeout(error, controller.signal, context.abortSignal)) {
      throw new SatiToolRuntimeError("tool_timeout", `web_search (tavily) timed out after ${timeoutMs}ms.`);
    }
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `web_search (tavily) request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `Tavily API error (${response.status}): ${truncate(detail, 500)}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;

  const organic: WebSearchOrganicResult[] = [];
  if (Array.isArray(raw.results)) {
    for (const r of (raw.results as Array<Record<string, unknown>>).slice(0, organicLimit)) {
      organic.push({
        title: readString(r.title),
        link: readString(r.url),
        snippet: readString(r.content),
        source: readString(r.url),
      });
    }
  }

  const output: WebSearchOutput = { query, organic };
  if (typeof raw.answer === "string" && raw.answer.length > 0) {
    output.answerBox = { answer: raw.answer };
  }

  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider: "tavily",
      endpoint,
      engine: "tavily",
      organicCount: organic.length,
    },
  };
}

type PerformGlmSearchInput = {
  input: WebSearchInput;
  context: SatiToolRuntimeContext;
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
};

export async function performGlmSearch(args: PerformGlmSearchInput): Promise<SatiToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, endpoint, fetchImpl, timeoutMs, organicLimit } = args;
  const query = input.query.trim();
  if (!query) {
    throw new SatiToolRuntimeError("invalid_tool_input", "web_search requires a non-empty `query`.");
  }

  const body: Record<string, unknown> = {
    search_engine: "search-prime",
    search_query: query,
    count: Math.max(1, Math.min(organicLimit, 50)),
    search_recency_filter: "noLimit",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  let response: Response;
  try {
    response = await networkFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      {
        timeoutMs,
        signal: controller.signal,
        fetchImpl,
        retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, retryOnPost: true },
      },
    );
  } catch (error) {
    if (isLocalTimeout(error, controller.signal, context.abortSignal)) {
      throw new SatiToolRuntimeError("tool_timeout", `web_search timed out after ${timeoutMs}ms.`);
    }
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `web_search (glm) request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `GLM web search error (${response.status}): ${truncate(detail, 500)}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;
  if (typeof raw.error === "string" && raw.error.length > 0) {
    throw new SatiToolRuntimeError("tool_execution_failed", `GLM web search error: ${raw.error}`);
  }
  const proxyCode = raw.code;
  if (typeof proxyCode === "number" && proxyCode !== 0) {
    const message = typeof raw.msg === "string" ? raw.msg : "search proxy error";
    throw new SatiToolRuntimeError("tool_execution_failed", `GLM web search error code=${proxyCode}: ${message}`);
  }
  const organic = parseGlmResults(extractResultItems(raw), organicLimit);
  const output: WebSearchOutput = { query, organic };

  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider: "glm",
      endpoint,
      organicCount: organic.length,
    },
  };
}

type PerformCustomSearchInput = {
  input: WebSearchInput;
  context: SatiToolRuntimeContext;
  apiKey: string | undefined;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
  custom: Required<WebSearchCustomProviderConfig>;
};

export async function performCustomSearch(
  args: PerformCustomSearchInput,
): Promise<SatiToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, endpoint, fetchImpl, timeoutMs, organicLimit, custom } = args;
  const query = input.query.trim();
  if (!query) {
    throw new SatiToolRuntimeError("invalid_tool_input", "web_search requires a non-empty `query`.");
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // 自定义 provider endpoint 不是合法 URL（new URL 抛 TypeError）→ 抛 invalid_tool_input 暴露配置错误，不静默改用默认端点。
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `web_search custom provider endpoint is not a valid URL: ${endpoint}`,
    );
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const body: Record<string, unknown> = {};
  const method = custom.method;

  if (method === "GET") {
    url.searchParams.set(custom.queryParam, query);
    if (input.gl?.trim()) url.searchParams.set("gl", input.gl.trim());
  } else {
    headers["Content-Type"] = "application/json";
    body[custom.queryParam] = query;
    if (input.gl?.trim()) body.gl = input.gl.trim();
  }

  if (custom.auth === "bearer" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (custom.auth === "queryApiKey" && apiKey) {
    url.searchParams.set(custom.apiKeyParam, apiKey);
  } else if (custom.auth === "bodyApiKey" && apiKey) {
    if (method === "GET") {
      url.searchParams.set(custom.apiKeyParam, apiKey);
    } else {
      body[custom.apiKeyParam] = apiKey;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  let response: Response;
  try {
    response = await networkFetch(
      url.toString(),
      {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      },
      {
        timeoutMs,
        signal: controller.signal,
        fetchImpl,
        retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, retryOnPost: method === "POST" },
      },
    );
  } catch (error) {
    if (isLocalTimeout(error, controller.signal, context.abortSignal)) {
      throw new SatiToolRuntimeError("tool_timeout", `web_search (custom) timed out after ${timeoutMs}ms.`);
    }
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `web_search (custom) request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `Custom web search error (${response.status}): ${truncate(detail, 500)}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;
  if (typeof raw.error === "string" && raw.error.length > 0) {
    throw new SatiToolRuntimeError("tool_execution_failed", `Custom web search error: ${raw.error}`);
  }
  const proxyCode = raw.code;
  if (typeof proxyCode === "number" && proxyCode !== 0) {
    const message = typeof raw.msg === "string" ? raw.msg : "search provider error";
    throw new SatiToolRuntimeError("tool_execution_failed", `Custom web search error code=${proxyCode}: ${message}`);
  }

  const resultValue = custom.resultsPath ? readPath(raw, custom.resultsPath) : extractResultItems(raw);
  const organic = parseMappedResults(resultValue, organicLimit, custom);
  const output: WebSearchOutput = { query, organic };

  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider: "custom",
      providerName: custom.name,
      endpoint,
      organicCount: organic.length,
    },
  };
}

function extractResultItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["search_result", "results", "items", "webPages", "data"]) {
    const child = value[key];
    if (Array.isArray(child)) return child;
    if (isRecord(child)) {
      const nested = extractResultItems(child);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function parseGlmResults(value: unknown, limit: number): WebSearchOrganicResult[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).slice(0, limit).map(entry => ({
    title: readString(entry.title) ?? readString(entry.name),
    link: readString(entry.url) ?? readString(entry.link) ?? readString(entry.href),
    snippet:
      readString(entry.snippet) ?? readString(entry.summary) ?? readString(entry.content) ?? readString(entry.text),
    source: readString(entry.source) ?? readString(entry.site) ?? readString(entry.media),
    publishedAt:
      readString(entry.publishedAt) ??
      readString(entry.published_at) ??
      readString(entry.publish_date) ??
      readString(entry.date),
  }));
}

function parseMappedResults(
  value: unknown,
  limit: number,
  mapping: Required<WebSearchCustomProviderConfig>,
): WebSearchOrganicResult[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).slice(0, limit).map(entry => ({
    title: readString(readPath(entry, mapping.titleField)),
    link: readString(readPath(entry, mapping.urlField)),
    snippet: readString(readPath(entry, mapping.snippetField)),
    source: readString(readPath(entry, mapping.sourceField)),
    publishedAt: readString(readPath(entry, mapping.publishedAtField)),
  }));
}

function readPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  return trimmed.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;
    return current[segment];
  }, value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatTextSummary(output: WebSearchOutput): string {
  const lines: string[] = [`Web search results for: ${output.query}`];
  if (output.answerBox) {
    lines.push("", "Answer box:", JSON.stringify(output.answerBox));
  }
  if (output.knowledgeGraph) {
    lines.push("", "Knowledge graph:", JSON.stringify(output.knowledgeGraph));
  }
  if (output.organic.length > 0) {
    lines.push("", "Organic results:");
    for (const entry of output.organic) {
      lines.push(`- ${entry.title ?? "(no title)"} — ${entry.link ?? ""}`);
      if (entry.snippet) lines.push(`  ${entry.snippet}`);
    }
  } else {
    lines.push("", "No organic results.");
  }
  if (output.topStories && output.topStories.length > 0) {
    lines.push("", `Top stories (${output.topStories.length}):`);
    for (const story of output.topStories) {
      const title = readString(story.title);
      const link = readString(story.link);
      lines.push(`- ${title ?? "(no title)"} — ${link ?? ""}`);
    }
  }
  return lines.join("\n");
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function isLocalTimeout(error: unknown, localSignal: AbortSignal, parentSignal: AbortSignal | undefined): boolean {
  if (parentSignal?.aborted) return false;
  return localSignal.aborted || isNetworkTimeoutError(error);
}

function isNetworkTimeoutError(error: unknown): boolean {
  return (
    (error instanceof NetworkFetchError && error.code === "network_timeout") ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "network_timeout")
  );
}
