import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { isProxyConnectionError } from "../../src/cli/proxy.js";
import { networkFetch } from "../../src/network/fetch.js";
import {
  registerProxyConnectionFallback,
  withDirectProxyFallback,
  type ProxyConnectionFallback,
} from "../../src/network/proxyFallback.js";

const PROXY_REFUSED = "connect ECONNREFUSED 127.0.0.1:9981";
const DIRECT_DISPATCHER = { name: "direct" };

function proxyError(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(PROXY_REFUSED), { code: "ECONNREFUSED" }),
  });
}

function fakeFallback(overrides: Partial<ProxyConnectionFallback> = {}): ProxyConnectionFallback {
  return {
    isProxyActive: () => true,
    isProxyConnectionError: error => error instanceof TypeError && error.message === "fetch failed",
    directDispatcher: async () => DIRECT_DISPATCHER,
    ...overrides,
  };
}

test("withDirectProxyFallback retries through the direct dispatcher when the proxy is unreachable", async () => {
  const dispatchers: unknown[] = [];
  const result = await withDirectProxyFallback(async dispatcher => {
    dispatchers.push(dispatcher);
    if (!dispatcher) throw proxyError();
    return "ok";
  }, fakeFallback());

  assert.equal(result, "ok");
  assert.deepEqual(dispatchers, [undefined, DIRECT_DISPATCHER]);
});

test("withDirectProxyFallback does not retry when no proxy is active", async () => {
  let calls = 0;
  const original = proxyError();
  await assert.rejects(
    withDirectProxyFallback(
      async () => {
        calls += 1;
        throw original;
      },
      fakeFallback({ isProxyActive: () => false }),
    ),
    (error: unknown) => error === original,
  );
  assert.equal(calls, 1);
});

test("withDirectProxyFallback does not retry failures unrelated to the proxy", async () => {
  let calls = 0;
  const original = new Error("socket hang up");
  await assert.rejects(
    withDirectProxyFallback(async () => {
      calls += 1;
      throw original;
    }, fakeFallback()),
    (error: unknown) => error === original,
  );
  assert.equal(calls, 1);
});

test("withDirectProxyFallback surfaces the proxy error when the direct retry also fails", async () => {
  const original = proxyError();
  let calls = 0;
  await assert.rejects(
    withDirectProxyFallback(async dispatcher => {
      calls += 1;
      throw dispatcher ? new Error("direct attempt failed") : original;
    }, fakeFallback()),
    (error: unknown) => error === original,
  );
  assert.equal(calls, 2);
});

test("withDirectProxyFallback is a no-op when no fallback is registered", async () => {
  const original = proxyError();
  await assert.rejects(
    withDirectProxyFallback(async () => {
      throw original;
    }, undefined),
    (error: unknown) => error === original,
  );
});

test("networkFetch does not consult the fallback for injected fetch implementations", async t => {
  let consulted = 0;
  registerProxyConnectionFallback(
    fakeFallback({
      isProxyActive: () => {
        consulted += 1;
        return true;
      },
    }),
  );
  t.after(() => registerProxyConnectionFallback(undefined));

  const original = proxyError();
  await assert.rejects(
    networkFetch(
      "https://example.test",
      {},
      {
        fetchImpl: async () => {
          throw original;
        },
      },
    ),
    (error: unknown) => error !== undefined && (error as { code?: string }).code === "network_connection_refused",
  );
  assert.equal(consulted, 0);
});

test("networkFetch falls back to a direct connection when the configured proxy is unreachable", async t => {
  const { Agent, ProxyAgent, setGlobalDispatcher } = await import("undici");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("local-ok");
  });
  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  // 第一次尝试固定经一个不可达代理：ProxyAgent 不参与 noProxy 旁路，回环目标也会
  // 走代理，因此必然触发连接失败与直连回退。回退后的直连目标就是本地这个服务。
  setGlobalDispatcher(new ProxyAgent("http://127.0.0.1:1"));
  registerProxyConnectionFallback({
    isProxyActive: () => true,
    isProxyConnectionError,
    directDispatcher: async () => new Agent(),
  });
  t.after(async () => {
    setGlobalDispatcher(new Agent());
    registerProxyConnectionFallback(undefined);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  });

  const response = await networkFetch(`http://127.0.0.1:${port}/`, {}, { timeoutMs: 5000 });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "local-ok");
});
