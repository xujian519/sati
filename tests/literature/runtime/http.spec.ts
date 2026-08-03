import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCache,
  getJSON,
  getText,
  literatureFetch,
  resetRateLimits,
  type LiteratureFetchOptions,
} from "../../../src/literature/runtime/http.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("literatureFetch caches healthy GET responses", async () => {
  clearCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ ok: 1 });
  };
  const url = "https://cache.test/works?search=hello";
  const opts = { fetchImpl, retry: { maxRetries: 0 } as const };
  const first = await literatureFetch(url, opts);
  const second = await literatureFetch(url, opts);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1); // 第二次命中缓存
  assert.equal(JSON.parse(second.body).ok, 1);
});

test("empty bodies are never cached", async () => {
  clearCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("", { status: 200 });
  };
  const url = "https://empty.test/feed";
  const opts = { fetchImpl, retry: { maxRetries: 0 } as const };
  await literatureFetch(url, opts);
  await literatureFetch(url, opts);
  assert.equal(calls, 2);
});

test("bodies rejected by looksValid are never cached", async () => {
  clearCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("<html>error page</html>", { status: 200 });
  };
  const url = "https://valid.test/feed";
  const opts: LiteratureFetchOptions = { fetchImpl, looksValid: b => b.startsWith("<feed"), retry: { maxRetries: 0 } };
  await literatureFetch(url, opts);
  await literatureFetch(url, opts);
  assert.equal(calls, 2);
});

test("non-ok responses are never cached", async () => {
  clearCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("rate limited", { status: 429 });
  };
  const url = "https://err.test/api";
  const opts = { fetchImpl, retry: { maxRetries: 0 } as const };
  const res = await literatureFetch(url, opts);
  assert.equal(res.ok, false);
  assert.equal(res.status, 429);
  await literatureFetch(url, opts);
  assert.equal(calls, 2);
});

test("per-host pacing spaces request starts by minIntervalMs", async () => {
  resetRateLimits();
  const starts: number[] = [];
  const fetchImpl: typeof fetch = async () => {
    starts.push(Date.now());
    return jsonResponse({});
  };
  const url = "https://pace.test/api?q=1";
  const url2 = "https://pace.test/api?q=2";
  const opts = { fetchImpl, rateLimit: { minIntervalMs: 40 }, retry: { maxRetries: 0 } as const };
  await literatureFetch(url, opts);
  await literatureFetch(url2, opts);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 30, `expected >= 30ms gap, got ${starts[1] - starts[0]}`);
});

test("maxConcurrent caps in-flight requests per host", async () => {
  resetRateLimits();
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 20));
    inFlight -= 1;
    return jsonResponse({});
  };
  const opts = { fetchImpl, rateLimit: { maxConcurrent: 2 }, retry: { maxRetries: 0 } as const };
  await Promise.all([
    literatureFetch("https://conc.test/a", opts),
    literatureFetch("https://conc.test/b", opts),
    literatureFetch("https://conc.test/c", opts),
  ]);
  assert.ok(peak <= 2, `expected peak <= 2, got ${peak}`);
});

test("getJSON parses JSON and throws LiteratureHttpError on non-2xx", async () => {
  const ok = await getJSON<{ a: number }>("https://json.test/ok", {
    fetchImpl: async () => jsonResponse({ a: 1 }),
    retry: { maxRetries: 0 } as const,
  });
  assert.deepEqual(ok, { a: 1 });

  await assert.rejects(
    getJSON("https://json.test/err", {
      fetchImpl: async () => new Response("boom", { status: 500 }),
      retry: { maxRetries: 0 } as const,
    }),
    err => err instanceof Error && err.name === "LiteratureHttpError" && (err as { status?: number }).status === 500,
  );
});

test("getText returns body with */* accept by default", async () => {
  let accept: string | null = null;
  const fetchImpl: typeof fetch = async (_url, init) => {
    accept = (init?.headers as Record<string, string>)["Accept"] ?? null;
    return new Response("<feed/>", { status: 200 });
  };
  const body = await getText("https://text.test/feed", { fetchImpl, retry: { maxRetries: 0 } as const });
  assert.equal(body, "<feed/>");
  assert.equal(accept, "*/*");
});

test("getJSON sets application/json accept", async () => {
  let accept: string | null = null;
  const fetchImpl: typeof fetch = async (_url, init) => {
    accept = (init?.headers as Record<string, string>)["Accept"] ?? null;
    return jsonResponse({});
  };
  await getJSON("https://accept.test/api", { fetchImpl, retry: { maxRetries: 0 } as const });
  assert.equal(accept, "application/json");
});
