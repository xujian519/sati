import test from "node:test";
import assert from "node:assert/strict";
import {
  createWebSearchTool,
  type WebSearchInput,
  type WebSearchOutput,
} from "../../src/tool/builtin/webSearch.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/index.js";
import { PilotDeckToolRuntimeError } from "../../src/tool/index.js";

const cwd = "/tmp/proj";

function makeContext(env?: NodeJS.ProcessEnv, signal?: AbortSignal): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: true }),
    env,
    abortSignal: signal,
  };
}

function fakeFetch(json: unknown, status = 200): typeof fetch {
  return (async () => {
    return new Response(typeof json === "string" ? json : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("web_search registers basic schema and metadata", () => {
  const tool = createWebSearchTool();
  assert.equal(tool.name, "web_search");
  assert.deepEqual(tool.aliases, ["WebSearch"]);
  assert.equal(tool.kind, "network");
  assert.equal(tool.isReadOnly({ query: "x" }), true);
  assert.equal(tool.isConcurrencySafe({ query: "x" }), true);
  assert.match(tool.description, /GLM\/Z\.AI, Tavily, or custom provider/);
  assert.match(tool.description, /Returns structured search data including organic results/);
  assert.match(tool.description, /GLM_WEB_SEARCH_API_KEY/);
  assert.equal(
    tool.inputSchema.properties?.query?.description,
    "Search query string. Be specific, and include versions or the current year when looking for recent documentation, releases, or current events.",
  );
  assert.equal(
    tool.inputSchema.properties?.gl?.description,
    'Optional country code for localized results. Defaults to "us"; use "cn" for China-localized results.',
  );
});

test("web_search throws unsupported_tool when no selected-provider API key is configured", async () => {
  const tool = createWebSearchTool({ fetchImpl: fakeFetch({}) });
  await assert.rejects(
    () => tool.execute({ query: "hello" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "unsupported_tool" &&
      /GLM_WEB_SEARCH_API_KEY/.test(error.message),
  );
});

test("web_search defaults to GLM and calls Z.AI web_search with Bearer auth", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const mock: typeof fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        search_result: [
          {
            title: "Z.AI News",
            link: "https://example.com/zai",
            content: "Z.AI current evidence",
            media: "example.com",
            publish_date: "2026-05-07",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const tool = createWebSearchTool({ apiKey: "glm-key", fetchImpl: mock });
  const out = await tool.execute({ query: "current risk" }, makeContext({}));

  assert.equal(capturedUrl, "https://api.z.ai/api/paas/v4/web_search");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer glm-key");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    search_engine: "search-prime",
    search_query: "current risk",
    count: 8,
    search_recency_filter: "noLimit",
  });
  assert.equal((out.metadata as { provider: string }).provider, "glm");
  assert.equal((out.data as WebSearchOutput).organic[0]?.title, "Z.AI News");
  assert.equal((out.data as WebSearchOutput).organic[0]?.link, "https://example.com/zai");
  assert.equal((out.data as WebSearchOutput).organic[0]?.snippet, "Z.AI current evidence");
});

test("web_search reads GLM key and endpoint from context env", async () => {
  let capturedUrl: string | undefined;
  const mock: typeof fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ search_result: [] }), { status: 200 });
  }) as typeof fetch;
  const tool = createWebSearchTool({ fetchImpl: mock });
  await tool.execute({ query: "x" }, makeContext({
    GLM_WEB_SEARCH_API_KEY: "env-key",
    GLM_WEB_SEARCH_ENDPOINT: "https://glm.example/search",
  }));
  assert.equal(capturedUrl, "https://glm.example/search");
});

test("web_search uses Tavily when provider is selected", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const mock: typeof fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        answer: "summary",
        results: [{ title: "Found", url: "https://x.example", content: "yes" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-key", fetchImpl: mock });
  const out = await tool.execute({ query: "foo" } satisfies WebSearchInput, makeContext({}));
  assert.equal(capturedUrl, "https://api.tavily.com/search");
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    api_key: "tvly-key",
    query: "foo",
    max_results: 8,
    include_answer: true,
    search_depth: "basic",
  });
  assert.equal((out.metadata as { provider: string }).provider, "tavily");
  assert.equal((out.data as WebSearchOutput).organic[0]?.link, "https://x.example");
  assert.deepEqual((out.data as WebSearchOutput).answerBox, { answer: "summary" });
});

test("web_search supports a custom POST provider with mapped result fields", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const mock: typeof fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        data: {
          hits: [
            {
              headline: "Custom hit",
              target: "https://custom.example/1",
              body: "custom snippet",
              site: "custom.example",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const tool = createWebSearchTool({
    provider: "custom",
    apiKey: "custom-key",
    endpoint: "https://custom.example/search",
    customProvider: {
      name: "My Search",
      auth: "bodyApiKey",
      method: "POST",
      queryParam: "q",
      apiKeyParam: "token",
      resultsPath: "data.hits",
      titleField: "headline",
      urlField: "target",
      snippetField: "body",
      sourceField: "site",
    },
    fetchImpl: mock,
  });
  const out = await tool.execute({ query: "custom query" }, makeContext({}));

  assert.equal(capturedUrl, "https://custom.example/search");
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    q: "custom query",
    token: "custom-key",
  });
  assert.equal((out.metadata as { provider: string }).provider, "custom");
  assert.equal((out.metadata as { providerName: string }).providerName, "My Search");
  assert.deepEqual((out.data as WebSearchOutput).organic[0], {
    title: "Custom hit",
    link: "https://custom.example/1",
    snippet: "custom snippet",
    source: "custom.example",
    publishedAt: undefined,
  });
});

test("web_search supports a custom GET provider with query-string auth", async () => {
  let capturedUrl: string | undefined;
  const mock: typeof fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;

  const tool = createWebSearchTool({
    provider: "custom",
    apiKey: "custom-key",
    endpoint: "https://custom.example/search",
    customProvider: {
      auth: "queryApiKey",
      method: "GET",
      queryParam: "text",
      apiKeyParam: "key",
    },
    fetchImpl: mock,
  });
  await tool.execute({ query: "hello", gl: "CN" }, makeContext({}));

  const url = new URL(capturedUrl!);
  assert.equal(url.searchParams.get("text"), "hello");
  assert.equal(url.searchParams.get("key"), "custom-key");
  assert.equal(url.searchParams.get("gl"), "CN");
});

test("web_search caps GLM count and returned organic results to organicLimit", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const search_result = Array.from({ length: 20 }, (_, i) => ({
    title: `R${i}`,
    link: `https://x.example/${i}`,
  }));
  const mock: typeof fetch = (async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ search_result }), { status: 200 });
  }) as typeof fetch;
  const tool = createWebSearchTool({
    apiKey: "k",
    organicLimit: 3,
    fetchImpl: mock,
  });
  const out = await tool.execute({ query: "x" }, makeContext({}));
  assert.equal(capturedBody?.count, 3);
  assert.equal((out.data as WebSearchOutput).organic.length, 3);
});

test("web_search reports HTTP non-2xx as tool_execution_failed", async () => {
  const mock: typeof fetch = (async () => new Response("internal err", { status: 500 })) as typeof fetch;
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: mock });
  await assert.rejects(
    () => tool.execute({ query: "x" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "tool_execution_failed" &&
      /GLM web search error \(500\)/.test(error.message),
  );
});

test("web_search reports provider error payloads as tool_execution_failed", async () => {
  const tool = createWebSearchTool({
    apiKey: "k",
    fetchImpl: fakeFetch({ error: "Invalid API key." }),
  });
  await assert.rejects(
    () => tool.execute({ query: "x" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "tool_execution_failed" &&
      /Invalid API key/.test(error.message),
  );
});

test("web_search reports proxy `code != 0` payload as tool_execution_failed", async () => {
  const tool = createWebSearchTool({
    apiKey: "k",
    fetchImpl: fakeFetch({ code: 1, msg: "rate limited" }),
  });
  await assert.rejects(
    () => tool.execute({ query: "x" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "tool_execution_failed" &&
      /code=1/.test(error.message),
  );
});

test("web_search rejects empty query as invalid_tool_input", async () => {
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: fakeFetch({}) });
  await assert.rejects(
    () => tool.execute({ query: "   " }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError && error.code === "invalid_tool_input",
  );
});

test("web_search times out after configured timeoutMs", async () => {
  const slow: typeof fetch = ((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = (init?.signal ?? null) as AbortSignal | null;
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }
    })) as typeof fetch;
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: slow, timeoutMs: 30 });
  await assert.rejects(
    () => tool.execute({ query: "slow" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError && error.code === "tool_timeout",
  );
});

test("web_search returns text content suitable for tool_result", async () => {
  const tool = createWebSearchTool({
    apiKey: "k",
    fetchImpl: fakeFetch({
      search_result: [{ title: "Found", link: "https://x.example", content: "yes" }],
    }),
  });
  const out = await tool.execute({ query: "hi" }, makeContext({}));
  const text = out.content.find((block) => block.type === "text") as { text: string };
  assert.match(text.text, /Web search results for: hi/);
  assert.match(text.text, /- Found — https:\/\/x\.example/);
});
