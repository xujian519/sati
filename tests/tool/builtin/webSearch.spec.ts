import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "../../../src/tool/builtin/webSearch.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 测试上下文：仅提供 execute 用到的最小字段集。 */
function testContext(): SatiToolRuntimeContext {
  return { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as unknown as SatiToolRuntimeContext;
}

test("web_search retries transient provider failures", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ error: "temporary" }, 500)
      : jsonResponse({ results: [{ title: "ok", url: "https://example.test", content: "snippet" }] });
  };
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-test", fetchImpl, timeoutMs: 1000 });

  const result = await tool.execute({ query: "hello" }, testContext());

  assert.equal(calls, 2);
  assert.equal(result.data?.organic[0]?.title, "ok");
});

test("web_search turns request timeout into tool_timeout", async () => {
  const fetchImpl: typeof fetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-test", fetchImpl, timeoutMs: 1 });

  await assert.rejects(tool.execute({ query: "hello" }, testContext()), { code: "tool_timeout" });
});

test("web_search turns network timeout errors into tool_timeout", async () => {
  const fetchImpl: typeof fetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(init?.signal?.reason), 0);
    });
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-test", fetchImpl, timeoutMs: 1 });

  await assert.rejects(tool.execute({ query: "hello" }, testContext()), { code: "tool_timeout" });
});
