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
  assert.match(tool.description, /SerpAPI-compatible or Tavily-compatible endpoints/);
  assert.match(tool.description, /Returns structured search data including organic results/);
  assert.match(tool.description, /Requires `TAVILY_API_KEY` or `SERP_API_KEY`/);
  assert.equal(
    tool.inputSchema.properties?.query?.description,
    "Search query string. Be specific, and include versions or the current year when looking for recent documentation, releases, or current events.",
  );
  assert.equal(
    tool.inputSchema.properties?.gl?.description,
    'Optional country code for localized results. Defaults to "us"; use "cn" for China-localized results.',
  );
});

test("web_search throws unsupported_tool when no API key configured", async () => {
  const tool = createWebSearchTool({ fetchImpl: fakeFetch({}) });
  await assert.rejects(
    () => tool.execute({ query: "hello" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "unsupported_tool" &&
      /SERP_API_KEY/.test(error.message),
  );
});

test("web_search reads SERP_API_KEY from context env and calls SerpAPI via GET", async () => {
  let capturedUrl: string | undefined;
  let capturedMethod: string | undefined;
  const mock: typeof fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedMethod = init?.method;
    return new Response(JSON.stringify({ organic_results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const tool = createWebSearchTool({ fetchImpl: mock });
  const out = await tool.execute({ query: "kimi k2.6" }, makeContext({ SERP_API_KEY: "test-key" }));
  assert.equal(capturedMethod, "GET");
  assert.match(capturedUrl!, /^https:\/\/serpapi\.com\/search\?/);
  const parsed = new URL(capturedUrl!);
  assert.equal(parsed.searchParams.get("engine"), "google");
  assert.equal(parsed.searchParams.get("q"), "kimi k2.6");
  assert.equal(parsed.searchParams.get("api_key"), "test-key");
  assert.equal(parsed.searchParams.get("output"), "json");
  assert.equal((out.data as WebSearchOutput).query, "kimi k2.6");
  assert.equal((out.metadata as { provider: string }).provider, "serpapi");
});

test("web_search forwards optional gl parameter", async () => {
  let capturedUrl: string | undefined;
  const mock: typeof fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ organic_results: [] }), { status: 200 });
  }) as typeof fetch;
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: mock });
  await tool.execute({ query: "foo", gl: "US" } satisfies WebSearchInput, makeContext({}));
  const parsed = new URL(capturedUrl!);
  assert.equal(parsed.searchParams.get("q"), "foo");
  assert.equal(parsed.searchParams.get("gl"), "US");
});

test("web_search parses organic_results + knowledge_graph + answer_box + top_stories", async () => {
  const apiPayload = {
    organic_results: [
      { title: "Result 1", link: "https://a.example/1", snippet: "sn1", source: "a" },
      { title: "Result 2", link: "https://a.example/2", snippet: "sn2" },
    ],
    knowledge_graph: { name: "Foo", type: "Thing" },
    answer_box: { answer: "42" },
    top_stories: [{ title: "Story", link: "https://news.example/1" }],
  };
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: fakeFetch(apiPayload) });
  const out = await tool.execute({ query: "life" }, makeContext({}));
  const data = out.data as WebSearchOutput;
  assert.equal(data.organic.length, 2);
  assert.equal(data.organic[0]?.title, "Result 1");
  assert.deepEqual(data.knowledgeGraph, { name: "Foo", type: "Thing" });
  assert.deepEqual(data.answerBox, { answer: "42" });
  assert.equal(data.topStories?.length, 1);
});

test("web_search also accepts the legacy `organic` key for compatible proxies", async () => {
  // Some SerpAPI-compatible proxies (older serp.hk-style) wrap in
  // `{ result: { organic: [...] } }` and use `organic` instead of
  // `organic_results`. The parser should still cope so users who set
  // `endpoint` to such a proxy don't break.
  const apiPayload = {
    result: {
      organic: [{ title: "Proxy hit", link: "https://x.example/1", snippet: "via proxy" }],
    },
  };
  const tool = createWebSearchTool({
    apiKey: "k",
    endpoint: "https://my-proxy.example/serp",
    fetchImpl: fakeFetch(apiPayload),
  });
  const out = await tool.execute({ query: "x" }, makeContext({}));
  assert.equal((out.data as WebSearchOutput).organic.length, 1);
  assert.equal((out.data as WebSearchOutput).organic[0]?.title, "Proxy hit");
});

test("web_search caps organic results to organicLimit", async () => {
  const organic_results = Array.from({ length: 20 }, (_, i) => ({
    title: `R${i}`,
    link: `https://x.example/${i}`,
  }));
  const tool = createWebSearchTool({
    apiKey: "k",
    organicLimit: 3,
    fetchImpl: fakeFetch({ organic_results }),
  });
  const out = await tool.execute({ query: "x" }, makeContext({}));
  assert.equal((out.data as WebSearchOutput).organic.length, 3);
});

test("web_search auto-selects bearer mode for serp.hk endpoint (POST + Authorization)", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const mock: typeof fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "成功",
        result: { organic: [{ title: "via bearer", link: "https://x" }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const tool = createWebSearchTool({
    apiKey: "hk-key",
    endpoint: "https://api.serp.hk/serp/google/search/advanced",
    fetchImpl: mock,
  });
  const out = await tool.execute({ query: "kimi" }, makeContext({}));
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedUrl, "https://api.serp.hk/serp/google/search/advanced");
  // No `?api_key=` in the URL — serp.hk takes the key via Bearer header.
  assert.ok(!capturedUrl?.includes("api_key="), "bearer mode must not put api_key in the URL");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer hk-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { q: "kimi" });
  assert.equal((out.data as WebSearchOutput).organic[0]?.title, "via bearer");
});

test("web_search explicit authMode override beats the hostname heuristic", async () => {
  // A custom proxy with a non-serp.hk hostname that still expects Bearer.
  let capturedInit: RequestInit | undefined;
  const mock: typeof fetch = (async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ organic_results: [] }), { status: 200 });
  }) as typeof fetch;
  const tool = createWebSearchTool({
    apiKey: "k",
    endpoint: "https://custom-proxy.example.com/search",
    authMode: "bearer",
    fetchImpl: mock,
  });
  await tool.execute({ query: "x" }, makeContext({}));
  assert.equal(capturedInit?.method, "POST");
  assert.equal((capturedInit?.headers as Record<string, string>)["Authorization"], "Bearer k");
});

test("web_search defaults to https://serpapi.com/search and honors endpoint override", async () => {
  let capturedUrl: string | undefined;
  const mock: typeof fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ organic_results: [] }), { status: 200 });
  }) as typeof fetch;

  const defaultTool = createWebSearchTool({ apiKey: "k", fetchImpl: mock });
  await defaultTool.execute({ query: "x" }, makeContext({}));
  assert.match(capturedUrl!, /^https:\/\/serpapi\.com\/search\?/);

  const proxyTool = createWebSearchTool({
    apiKey: "k",
    endpoint: "https://my-proxy.example/serp",
    fetchImpl: mock,
  });
  await proxyTool.execute({ query: "x" }, makeContext({}));
  assert.match(capturedUrl!, /^https:\/\/my-proxy\.example\/serp\?/);
});

test("web_search reports HTTP non-2xx as tool_execution_failed", async () => {
  const mock: typeof fetch = (async () => new Response("internal err", { status: 500 })) as typeof fetch;
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: mock });
  await assert.rejects(
    () => tool.execute({ query: "x" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "tool_execution_failed" &&
      /SerpAPI error \(500\)/.test(error.message),
  );
});

test("web_search reports SerpAPI 200-with-error payload as tool_execution_failed", async () => {
  const tool = createWebSearchTool({
    apiKey: "k",
    fetchImpl: fakeFetch({ error: "Invalid API key. Your API key should be here: ..." }),
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
      organic_results: [{ title: "Found", link: "https://x.example", snippet: "yes" }],
    }),
  });
  const out = await tool.execute({ query: "hi" }, makeContext({}));
  const text = out.content.find((block) => block.type === "text") as { text: string };
  assert.match(text.text, /Web search results for: hi/);
  assert.match(text.text, /- Found — https:\/\/x\.example/);
});
