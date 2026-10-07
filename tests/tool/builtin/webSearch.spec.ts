import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "../../../src/tool/builtin/webSearch.js";
import { WEB_SEARCH_ENDPOINTS, type WebSearchProvider } from "../../../src/pilot/config/webSearchProviders.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

/** 每个 provider 的一次成功响应形状（用于只关心"打到哪"的守护测试）。 */
const PROVIDER_PAYLOADS: Record<Exclude<WebSearchProvider, "custom">, unknown> = {
  glm: { search_result: [] },
  tavily: { results: [] },
  serper: { organic: [] },
  brave: { web: { results: [] } },
  baidu: { references: [] },
  bocha: { code: 0, data: { webPages: { value: [] } } },
  exa: { results: [] },
  serpapi: { search_metadata: { status: "Success" } },
};

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

// ─── 补充 provider（baidu / bocha / exa / serpapi / serper / brave）──────────

test("web_search routes every provider to its own endpoint (no silent GLM fallthrough)", async () => {
  // 回归防护：serper / brave 曾无执行分支，穿透到 execute() 末尾的 GLM 兜底，
  // 把别家 API key 当 GLM token 以 Bearer 发到 api.z.ai，搜索全失败且密钥外泄。
  // 逐个 provider 断言实际请求落到自己的端点——将来新增 provider 漏接分支即红。
  const entries = Object.entries(PROVIDER_PAYLOADS) as Array<[Exclude<WebSearchProvider, "custom">, unknown]>;

  for (const [provider, payload] of entries) {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async url => {
      capturedUrl = String(url);
      return jsonResponse(payload);
    };
    const tool = createWebSearchTool({ provider, apiKey: "probe-key", fetchImpl, timeoutMs: 1000 });

    await tool.execute({ query: "hello" }, testContext());

    const expected = WEB_SEARCH_ENDPOINTS[provider];
    assert.equal(capturedUrl.startsWith(expected), true, `${provider} 未打到自己的端点，实际：${capturedUrl}`);
  }
});

test("web_search keeps each new provider's key on its own host with its own auth header", async () => {
  const call = async (provider: "serper" | "brave") => {
    let captured = { url: "", headers: {} as Record<string, string> };
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      return jsonResponse(PROVIDER_PAYLOADS[provider]);
    };
    const tool = createWebSearchTool({ provider, apiKey: `${provider}-key`, fetchImpl, timeoutMs: 1000 });
    await tool.execute({ query: "hello" }, testContext());
    return captured;
  };

  const serper = await call("serper");
  assert.equal(serper.url, "https://google.serper.dev/search");
  assert.equal(serper.headers["X-API-KEY"], "serper-key");
  assert.equal(serper.headers.Authorization, undefined);
  assert.equal(serper.headers["X-Subscription-Token"], undefined);

  const brave = await call("brave");
  assert.equal(brave.url.startsWith("https://api.search.brave.com/res/v1/web/search"), true);
  assert.equal(brave.headers["X-Subscription-Token"], "brave-key");
  assert.equal(brave.headers.Authorization, undefined);
  assert.equal(brave.headers["X-API-KEY"], undefined);
});

test("web_search routes a supplementary provider through its default endpoint", async () => {
  let capturedUrl = "";
  const fetchImpl: typeof fetch = async url => {
    capturedUrl = String(url);
    return jsonResponse({ results: [{ title: "R", url: "https://r.test", summary: "s" }] });
  };
  const tool = createWebSearchTool({ provider: "exa", apiKey: "exa-key", fetchImpl, timeoutMs: 1000 });

  const result = await tool.execute({ query: "hello" }, testContext());

  assert.equal(capturedUrl, "https://api.exa.ai/search");
  assert.equal(result.data?.organic[0]?.title, "R");
});

test("web_search infers a supplementary provider from its environment key", async () => {
  let capturedUrl = "";
  const fetchImpl: typeof fetch = async url => {
    capturedUrl = String(url);
    return jsonResponse({ code: 0, data: { webPages: { value: [] } } });
  };
  const tool = createWebSearchTool({ fetchImpl, timeoutMs: 1000 });
  const context = {
    env: { BOCHA_API_KEY: "bo-key" },
    cwd: "/",
    projectRoot: "/",
  } as unknown as SatiToolRuntimeContext;

  await tool.execute({ query: "hello" }, context);

  assert.equal(capturedUrl, "https://api.bocha.cn/v1/web-search");
});

test("web_search keeps the api key out of a supplementary provider's network error", async () => {
  // serpapi 走 query 认证：密钥在 URL 上，底层网络错误很容易把整条 URL 带出来。
  const fetchImpl: typeof fetch = async url => {
    throw new Error(`connect failed for ${String(url)}`);
  };
  const tool = createWebSearchTool({ provider: "serpapi", apiKey: "sp-secret", fetchImpl, timeoutMs: 1000 });

  await assert.rejects(tool.execute({ query: "hello" }, testContext()), (error: Error) => {
    assert.equal(error.message.includes("sp-secret"), false);
    return true;
  });
});

test("web_search surfaces a supplementary provider's HTTP error with the key redacted", async () => {
  const fetchImpl: typeof fetch = async () => new Response("invalid api key sp-secret", { status: 401 });
  const tool = createWebSearchTool({ provider: "serpapi", apiKey: "sp-secret", fetchImpl, timeoutMs: 1000 });

  await assert.rejects(tool.execute({ query: "hello" }, testContext()), (error: Error) => {
    assert.equal(error.message.includes("sp-secret"), false);
    assert.equal(error.message.includes("401"), true);
    return true;
  });
});
