import type { PermissionResult } from "../../permission/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

/**
 * `web_search` calls SerpAPI (https://serpapi.com) — the canonical Google
 * search-as-an-API service. SerpAPI uses a single REST endpoint that takes
 * the API key as a `?api_key=...` query parameter and returns JSON with
 * `organic_results`, `knowledge_graph`, `answer_box`, `top_stories`, etc.
 *
 * Why SerpAPI as the only built-in provider?
 *   - It's the de-facto standard a model would expect to integrate against.
 *   - One canonical surface keeps tool semantics deterministic across
 *     deployments — provider-specific quirks (different keys, request
 *     shapes, response field renames) live behind one well-documented API.
 *
 * If a deployment needs a self-hosted SerpAPI-compatible proxy (e.g.
 * serp.hk for in-China access), pass `endpoint` to override the base URL.
 *
 * Two on-the-wire dialects are supported and auto-selected from the
 * endpoint hostname:
 *   - **query** (default — `serpapi.com`): `GET ?engine=…&q=…&api_key=…`.
 *   - **bearer** (`*.serp.hk`, `*.serp.global`): `POST` with
 *     `Authorization: Bearer <key>` and `{q}` JSON body. serp.hk migrated
 *     away from the legacy `?api_key=` GET path; using it with a current
 *     serp.hk key returns `code=3103 未授权`.
 *
 * Override `authMode` to force a dialect (e.g. when targeting a custom
 * proxy whose hostname doesn't match the heuristic).
 *
 * API key resolution order (first non-empty wins):
 *   1. `options.apiKey`
 *   2. context env var `SERP_API_KEY` (legacy fallback)
 *
 * Without a key the tool is still registered but `execute()` returns the
 * canonical `unsupported_tool` error so the model gets a deterministic
 * "configure SERP_API_KEY" hint rather than a silent failure.
 */
/** How the provider authenticates and ships the query. See file header. */
export type WebSearchAuthMode = "query" | "bearer" | "tavily";

export type CreateWebSearchToolOptions = {
  apiKey?: string;
  /** Override the SerpAPI endpoint (default `https://serpapi.com/search`). */
  endpoint?: string;
  /** Override the search engine (default `google`). SerpAPI also supports `bing`, `duckduckgo`, etc. */
  engine?: string;
  /**
   * Override the auth dialect. When unset, auto-detected from
   * `endpoint`'s hostname (`*.serp.hk` / `*.serp.global` → `bearer`,
   * `api.tavily.com` → `tavily`, everything else → `query`).
   */
  authMode?: WebSearchAuthMode;
  /** Tavily API key — when set, automatically switches to tavily mode. */
  tavilyApiKey?: string;
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

export type WebSearchOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
};

export type WebSearchOutput = {
  query: string;
  organic: WebSearchOrganicResult[];
  knowledgeGraph?: Record<string, unknown>;
  answerBox?: Record<string, unknown>;
  topStories?: Array<Record<string, unknown>>;
};

const DEFAULT_ENDPOINT = "https://serpapi.com/search";
const DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_ENGINE = "google";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ORGANIC_LIMIT = 8;
const DEFAULT_TOP_STORIES_LIMIT = 5;

export function createWebSearchTool(
  options: CreateWebSearchToolOptions = {},
): PilotDeckToolDefinition<WebSearchInput, WebSearchOutput> {
  const hasTavily = Boolean(options.tavilyApiKey?.trim());
  const endpoint = options.endpoint ?? (hasTavily ? DEFAULT_TAVILY_ENDPOINT : DEFAULT_ENDPOINT);
  const engine = options.engine ?? DEFAULT_ENGINE;
  const authMode = options.authMode ?? (hasTavily ? "tavily" as WebSearchAuthMode : detectAuthMode(endpoint));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const organicLimit = options.organicLimit ?? DEFAULT_ORGANIC_LIMIT;
  const topStoriesLimit = options.topStoriesLimit ?? DEFAULT_TOP_STORIES_LIMIT;

  return {
    name: "web_search",
    aliases: ["WebSearch"],
    description: `- Searches the web for current information using SerpAPI-compatible or Tavily-compatible endpoints
- Takes a search query and optional country code (\`gl\`) as input
- Returns structured search data including organic results and, when available, knowledge graph, answer box, and top stories
- Use this tool for current events, recent documentation, and information beyond the model's knowledge cutoff

Usage notes:
  - Requires \`TAVILY_API_KEY\` or \`SERP_API_KEY\`, or \`tools.webSearch.apiKey\` / \`tools.webSearch.tavilyApiKey\` in \`pilotdeck.yaml\`
  - Supports localized results via the optional \`gl\` parameter (default: \`us\`; use \`cn\` for China-localized results)
  - Supports SerpAPI-compatible endpoint overrides; auth mode is auto-detected for Tavily, \`*.serp.hk\`, and \`*.serp.global\`, and can also be configured explicitly
  - This tool is read-only and does not modify files`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Search query string. Be specific, and include versions or the current year when looking for recent documentation, releases, or current events.",
        },
        gl: {
          type: "string",
          description: 'Optional country code for localized results. Defaults to "us"; use "cn" for China-localized results.',
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
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
      const apiKey = resolveApiKey(options.apiKey, context, options.tavilyApiKey);
      if (!apiKey) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "web_search is not configured. Set TAVILY_API_KEY or SERP_API_KEY env var, or set tools.webSearch.apiKey / tavilyApiKey in pilotdeck.yaml.",
        );
      }
      const isTavily = authMode === "tavily"
        || apiKey.startsWith("tvly-")
        || Boolean((context.env ?? process.env).TAVILY_API_KEY?.trim());
      if (isTavily) {
        return performTavilySearch({
          input,
          context,
          apiKey,
          endpoint: endpoint.includes("tavily") ? endpoint : DEFAULT_TAVILY_ENDPOINT,
          fetchImpl,
          timeoutMs,
          organicLimit,
        });
      }
      return performSearch({
        input,
        context,
        apiKey,
        endpoint,
        engine,
        authMode,
        fetchImpl,
        timeoutMs,
        organicLimit,
        topStoriesLimit,
      });
    },
  };
}

/**
 * Pick the on-the-wire dialect from the endpoint's hostname.
 *
 * `*.serp.hk` and `*.serp.global` no longer accept the legacy `?api_key=`
 * GET shape; using it returns `code=3103 未授权` regardless of whether the
 * key is valid. Default to `query` for `serpapi.com` and anything else.
 */
function detectAuthMode(endpoint: string): WebSearchAuthMode {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host === "api.tavily.com" || host.endsWith(".tavily.com")) return "tavily";
    if (host === "serp.hk" || host.endsWith(".serp.hk")) return "bearer";
    if (host === "serp.global" || host.endsWith(".serp.global")) return "bearer";
  } catch {
    // fall through
  }
  return "query";
}

function resolveApiKey(
  optionApiKey: string | undefined,
  context: PilotDeckToolRuntimeContext,
  tavilyApiKey?: string,
): string | undefined {
  if (tavilyApiKey?.trim()) return tavilyApiKey.trim();
  const fromOption = optionApiKey?.trim();
  if (fromOption) {
    return fromOption;
  }
  const fromTavilyEnv = (context.env ?? process.env).TAVILY_API_KEY?.trim();
  if (fromTavilyEnv && fromTavilyEnv.length > 0) return fromTavilyEnv;
  const fromEnv = (context.env ?? process.env).SERP_API_KEY?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

type PerformTavilySearchInput = {
  input: WebSearchInput;
  context: PilotDeckToolRuntimeContext;
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
};

async function performTavilySearch(
  args: PerformTavilySearchInput,
): Promise<PilotDeckToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, endpoint, fetchImpl, timeoutMs, organicLimit } = args;
  const query = input.query.trim();
  if (!query) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "web_search requires a non-empty `query`.",
    );
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
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && context.abortSignal?.aborted !== true) {
      throw new PilotDeckToolRuntimeError(
        "tool_timeout",
        `web_search (tavily) timed out after ${timeoutMs}ms.`,
      );
    }
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `web_search (tavily) request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new PilotDeckToolRuntimeError(
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

type PerformSearchInput = {
  input: WebSearchInput;
  context: PilotDeckToolRuntimeContext;
  apiKey: string;
  endpoint: string;
  engine: string;
  authMode: WebSearchAuthMode;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
  topStoriesLimit: number;
};

async function performSearch(
  args: PerformSearchInput,
): Promise<PilotDeckToolExecutionOutput<WebSearchOutput>> {
  const {
    input,
    context,
    apiKey,
    endpoint,
    engine,
    authMode,
    fetchImpl,
    timeoutMs,
    organicLimit,
    topStoriesLimit,
  } = args;
  const query = input.query.trim();
  if (!query) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "web_search requires a non-empty `query`.",
    );
  }

  const requestUrl: string =
    authMode === "bearer" ? endpoint : buildQueryModeUrl({ endpoint, engine, apiKey, query, gl: input.gl });
  const requestInit: RequestInit =
    authMode === "bearer"
      ? buildBearerModeInit({ apiKey, engine, query, gl: input.gl })
      : { method: "GET", headers: { Accept: "application/json" } };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      ...requestInit,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && context.abortSignal?.aborted !== true) {
      throw new PilotDeckToolRuntimeError(
        "tool_timeout",
        `web_search timed out after ${timeoutMs}ms.`,
      );
    }
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `web_search request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `SerpAPI error (${response.status}): ${truncate(detail, 500)}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;
  // SerpAPI returns `{ error: "..." }` on logical failures with a 200 status
  // (e.g. "Invalid API key", quota issues). Surface those explicitly.
  if (typeof raw.error === "string" && raw.error.length > 0) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `SerpAPI error: ${raw.error}`,
    );
  }

  // Some SerpAPI-compatible proxies wrap the payload as `{ code, msg, result }`.
  // Unwrap when present so the same parser works for both shapes.
  const proxyCode = raw.code;
  if (typeof proxyCode === "number" && proxyCode !== 0) {
    const message = typeof raw.msg === "string" ? raw.msg : "search proxy error";
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `SerpAPI error code=${proxyCode}: ${message}`,
    );
  }
  const result = (isRecord(raw.result) ? raw.result : raw) as Record<string, unknown>;

  // SerpAPI canonical key is `organic_results`; some compatible proxies
  // (serp.hk-style) call it `organic`. Accept both.
  const organicSource = result.organic_results ?? result.organic;
  const organic = parseOrganic(organicSource, organicLimit);
  const output: WebSearchOutput = { query, organic };
  if (isRecord(result.knowledge_graph)) {
    output.knowledgeGraph = result.knowledge_graph;
  }
  if (isRecord(result.answer_box)) {
    output.answerBox = result.answer_box;
  }
  const topStoriesSource = result.top_stories;
  if (Array.isArray(topStoriesSource) && topStoriesSource.length > 0) {
    output.topStories = (topStoriesSource as Array<Record<string, unknown>>).slice(
      0,
      topStoriesLimit,
    );
  }

  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider: "serpapi",
      endpoint,
      engine,
      organicCount: organic.length,
    },
  };
}

function buildQueryModeUrl(args: {
  endpoint: string;
  engine: string;
  apiKey: string;
  query: string;
  gl?: string;
}): string {
  // SerpAPI takes everything via query string. Build it deterministically
  // so tests can assert on the URL shape.
  const url = new URL(args.endpoint);
  url.searchParams.set("engine", args.engine);
  url.searchParams.set("q", args.query);
  if (args.gl && args.gl.trim().length > 0) {
    url.searchParams.set("gl", args.gl.trim());
  }
  url.searchParams.set("api_key", args.apiKey);
  url.searchParams.set("output", "json");
  return url.toString();
}

function buildBearerModeInit(args: {
  apiKey: string;
  engine: string;
  query: string;
  gl?: string;
}): RequestInit {
  // serp.hk-style: POST + Bearer auth + JSON body. The proxy infers the
  // engine and locale defaults itself; we still forward them when the
  // caller specified non-defaults so behaviour matches the query-mode path.
  const body: Record<string, unknown> = { q: args.query };
  if (args.engine && args.engine !== DEFAULT_ENGINE) body.engine = args.engine;
  if (args.gl && args.gl.trim().length > 0) body.gl = args.gl.trim();
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  };
}

function parseOrganic(value: unknown, limit: number): WebSearchOrganicResult[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).slice(0, limit).map((entry) => ({
    title: readString(entry.title),
    link: readString(entry.link),
    snippet: readString(entry.snippet),
    source: readString(entry.source) ?? readString(entry.displayed_link),
  }));
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
