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

test("web_search reads SERP_API_KEY from context env", async () => {
  let capturedAuth: string | undefined;
  let capturedBody: string | undefined;
  const mock: typeof fetch = (async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    capturedAuth = headers.Authorization;
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ result: { organic: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const tool = createWebSearchTool({ fetchImpl: mock });
  const out = await tool.execute({ query: "kimi k2.6" }, makeContext({ SERP_API_KEY: "test-key" }));
  assert.equal(capturedAuth, "Bearer test-key");
  assert.deepEqual(JSON.parse(capturedBody!), { q: "kimi k2.6" });
  assert.equal((out.data as WebSearchOutput).query, "kimi k2.6");
});

test("web_search forwards optional gl parameter", async () => {
  let capturedBody: string | undefined;
  const mock: typeof fetch = (async (_url, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ result: { organic: [] } }), { status: 200 });
  }) as typeof fetch;
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: mock });
  await tool.execute({ query: "foo", gl: "US" } satisfies WebSearchInput, makeContext({}));
  assert.deepEqual(JSON.parse(capturedBody!), { q: "foo", gl: "US" });
});

test("web_search parses organic + knowledge_graph + answer_box + top_stories", async () => {
  const apiPayload = {
    result: {
      organic: [
        { title: "Result 1", link: "https://a.example/1", snippet: "sn1", source: "a" },
        { title: "Result 2", link: "https://a.example/2", snippet: "sn2" },
      ],
      knowledge_graph: { name: "Foo", type: "Thing" },
      answer_box: { answer: "42" },
      top_stories: [{ title: "Story", link: "https://news.example/1" }],
    },
  };
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: fakeFetch(apiPayload) });
  const out = await tool.execute({ query: "life" }, makeContext({}));
  const data = out.data as WebSearchOutput;
  assert.equal(data.organic.length, 2);
  assert.equal(data.organic[0]?.title, "Result 1");
  assert.deepEqual(data.knowledgeGraph, { name: "Foo", type: "Thing" });
  assert.deepEqual(data.answerBox, { answer: "42" });
  assert.equal(data.topStories?.length, 1);
  assert.equal((out.metadata as { provider: string }).provider, "serp.hk");
});

test("web_search caps organic results to organicLimit", async () => {
  const organic = Array.from({ length: 20 }, (_, i) => ({ title: `R${i}`, link: `https://x.example/${i}` }));
  const tool = createWebSearchTool({
    apiKey: "k",
    organicLimit: 3,
    fetchImpl: fakeFetch({ result: { organic } }),
  });
  const out = await tool.execute({ query: "x" }, makeContext({}));
  assert.equal((out.data as WebSearchOutput).organic.length, 3);
});

test("web_search picks endpoint based on region", async () => {
  let capturedUrl: string | undefined;
  const mock: typeof fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ result: { organic: [] } }), { status: 200 });
  }) as typeof fetch;
  const tool = createWebSearchTool({ apiKey: "k", region: "global", fetchImpl: mock });
  await tool.execute({ query: "x" }, makeContext({}));
  assert.match(capturedUrl!, /api\.serp\.global/);

  const tool2 = createWebSearchTool({ apiKey: "k", region: "cn", fetchImpl: mock });
  await tool2.execute({ query: "x" }, makeContext({}));
  assert.match(capturedUrl!, /api\.serp\.hk/);
});

test("web_search reports HTTP non-2xx as tool_execution_failed", async () => {
  const mock: typeof fetch = (async () => new Response("internal err", { status: 500 })) as typeof fetch;
  const tool = createWebSearchTool({ apiKey: "k", fetchImpl: mock });
  await assert.rejects(
    () => tool.execute({ query: "x" }, makeContext({})),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "tool_execution_failed" &&
      /serp\.hk API error \(500\)/.test(error.message),
  );
});

test("web_search reports JSON code != 0 as tool_execution_failed", async () => {
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
      result: { organic: [{ title: "Found", link: "https://x.example", snippet: "yes" }] },
    }),
  });
  const out = await tool.execute({ query: "hi" }, makeContext({}));
  const text = out.content.find((block) => block.type === "text") as { text: string };
  assert.match(text.text, /Web search results for: hi/);
  assert.match(text.text, /- Found — https:\/\/x\.example/);
});
