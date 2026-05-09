import type { PermissionResult } from "../../permission/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

/**
 * Provider design follows the openclaw `serp-search` plugin
 * (`/Users/miwi/edgeclaw-opc/openclaw/extensions/serp-search/index.ts`):
 * delegate the actual crawling / ranking / locale handling to the serp.hk
 * commercial proxy, which exposes a Google-search-as-an-API endpoint that
 * works inside China without a VPN.
 *
 * Endpoints:
 *   - `cn`     → https://api.serp.hk/serp/google/search/advanced  (default)
 *   - `global` → https://api.serp.global/serp/google/search/advanced
 *
 * API key resolution order (first non-empty wins):
 *   1. `options.apiKey`
 *   2. context env var `SERP_API_KEY`
 *
 * Without a key the tool is still registered but `execute()` returns the
 * canonical `unsupported_tool` error so the model gets a deterministic
 * "configure SERP_API_KEY" hint rather than a silent failure.
 */
export type WebSearchRegion = "cn" | "global";

export type CreateWebSearchToolOptions = {
  apiKey?: string;
  region?: WebSearchRegion;
  /** Override endpoint (testing). */
  endpoint?: string;
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Override timeout (default 30s). */
  timeoutMs?: number;
  /** Cap on organic results returned to the model (default 8 — matches serp-search). */
  organicLimit?: number;
  /** Cap on top-stories returned (default 5 — matches serp-search). */
  topStoriesLimit?: number;
};

export type WebSearchInput = {
  /** Search query string. */
  query: string;
  /** Country code for localized results (default "CN"). Use "US" for English. */
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

const SERP_HK_ENDPOINT = "https://api.serp.hk/serp/google/search/advanced";
const SERP_GLOBAL_ENDPOINT = "https://api.serp.global/serp/google/search/advanced";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ORGANIC_LIMIT = 8;
const DEFAULT_TOP_STORIES_LIMIT = 5;

export function createWebSearchTool(
  options: CreateWebSearchToolOptions = {},
): PilotDeckToolDefinition<WebSearchInput, WebSearchOutput> {
  const region: WebSearchRegion = options.region ?? "cn";
  const endpoint =
    options.endpoint ?? (region === "global" ? SERP_GLOBAL_ENDPOINT : SERP_HK_ENDPOINT);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const organicLimit = options.organicLimit ?? DEFAULT_ORGANIC_LIMIT;
  const topStoriesLimit = options.topStoriesLimit ?? DEFAULT_TOP_STORIES_LIMIT;

  return {
    name: "web_search",
    aliases: ["WebSearch"],
    description:
      "Search Google via the serp.hk proxy. Returns organic results, knowledge graph, answer box, and top stories. Works in China without VPN.",
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search query string." },
        gl: {
          type: "string",
          description: 'Country code for localized results (default "CN"). Use "US" for English.',
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
      const apiKey = resolveApiKey(options.apiKey, context);
      if (!apiKey) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "web_search is not configured. Set SERP_API_KEY env var or pass apiKey via createWebSearchTool({ apiKey }).",
        );
      }
      return performSearch({
        input,
        context,
        apiKey,
        endpoint,
        fetchImpl,
        timeoutMs,
        organicLimit,
        topStoriesLimit,
      });
    },
  };
}

function resolveApiKey(
  optionApiKey: string | undefined,
  context: PilotDeckToolRuntimeContext,
): string | undefined {
  const fromOption = optionApiKey?.trim();
  if (fromOption) {
    return fromOption;
  }
  const fromEnv = (context.env ?? process.env).SERP_API_KEY?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

type PerformSearchInput = {
  input: WebSearchInput;
  context: PilotDeckToolRuntimeContext;
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
  topStoriesLimit: number;
};

async function performSearch(
  args: PerformSearchInput,
): Promise<PilotDeckToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, endpoint, fetchImpl, timeoutMs, organicLimit, topStoriesLimit } =
    args;
  const query = input.query.trim();
  if (!query) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "web_search requires a non-empty `query`.",
    );
  }

  const body: Record<string, string> = { q: query };
  if (input.gl && input.gl.trim().length > 0) {
    body.gl = input.gl.trim();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
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
      `serp.hk API error (${response.status}): ${detail}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;
  if (typeof raw.code === "number" && raw.code !== 0) {
    const message = typeof raw.msg === "string" ? raw.msg : "serp.hk error";
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `serp.hk error code=${raw.code}: ${message}`,
    );
  }

  const result = (raw.result ?? raw) as Record<string, unknown>;
  const organic = parseOrganic(result.organic, organicLimit);
  const output: WebSearchOutput = { query, organic };
  if (isRecord(result.knowledge_graph)) {
    output.knowledgeGraph = result.knowledge_graph;
  }
  if (isRecord(result.answer_box)) {
    output.answerBox = result.answer_box;
  }
  if (Array.isArray(result.top_stories) && result.top_stories.length > 0) {
    output.topStories = (result.top_stories as Array<Record<string, unknown>>).slice(
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
      provider: "serp.hk",
      endpoint,
      organicCount: organic.length,
    },
  };
}

function parseOrganic(value: unknown, limit: number): WebSearchOrganicResult[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).slice(0, limit).map((entry) => ({
    title: readString(entry.title),
    link: readString(entry.link),
    snippet: readString(entry.snippet),
    source: readString(entry.source),
  }));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
