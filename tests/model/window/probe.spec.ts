/**
 * 窗口探测执行器：端点候选回退、鉴权头、失败静默、写入覆盖层。
 *
 * 全部用注入的 fetchImpl（铁律 8：单测 mock 外部网络），不发真实请求。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildModelWindowProbeHeaders,
  probeAndRecordProviderModelWindows,
  probeProviderModelWindows,
} from "../../../src/model/window/probe.js";
import { ModelWindowStore } from "../../../src/model/window/store.js";

const NOW = "2026-09-19T00:00:00.000Z";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 401,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

test("鉴权头按协议构造（openai/anthropic/google）", () => {
  assert.equal(buildModelWindowProbeHeaders({ protocol: "openai", apiKey: "sk-1" }).authorization, "Bearer sk-1");
  const anthropic = buildModelWindowProbeHeaders({ protocol: "anthropic", apiKey: "sk-a" });
  assert.equal(anthropic["x-api-key"], "sk-a");
  assert.equal(anthropic["anthropic-version"], "2023-06-01");
  assert.equal(buildModelWindowProbeHeaders({ protocol: "google", apiKey: "g-1" })["x-goog-api-key"], "g-1");
  // 无 key 时不注入鉴权头；自定义头保留。
  const bare = buildModelWindowProbeHeaders({ protocol: "openai", headers: { "x-tenant": "t1" } });
  assert.equal(bare.authorization, undefined);
  assert.equal(bare["x-tenant"], "t1");
});

test("探测成功：返回条目并可写入覆盖层（source: probe）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-window-probe-"));
  try {
    const store = new ModelWindowStore(join(dir, "model-windows.json"));
    const fetchImpl = (async () =>
      jsonResponse({
        data: [{ id: "vendor/model-a", context_length: 262144, top_provider: { max_completion_tokens: 64000 } }],
      })) as unknown as typeof fetch;

    const result = await probeAndRecordProviderModelWindows({
      provider: "openrouter",
      protocol: "openai",
      baseUrl: "https://openrouter.test/api/v1",
      store,
      now: () => new Date(NOW),
      fetchImpl,
    });

    assert.equal(result.recorded, 1);
    assert.equal(result.hits[0]?.maxContextTokens, 262144);
    const entry = store.lookup("openrouter", "vendor/model-a");
    assert.equal(entry?.maxContextTokens, 262144);
    assert.equal(entry?.maxOutputTokens, 64000);
    assert.equal(entry?.source, "probe");
    assert.equal(entry?.via, "context_length");
    assert.equal(entry?.updatedAt, NOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("候选回退：首个候选无窗口事实时继续试下一个", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (calls.length === 1) return jsonResponse({ data: [{ id: "m", object: "model" }] });
    return jsonResponse({ data: [{ id: "m", context_length: 131072 }] });
  }) as unknown as typeof fetch;

  const hits = await probeProviderModelWindows({
    provider: "proxy",
    protocol: "openai",
    baseUrl: "https://proxy.test",
    fetchImpl,
  });
  assert.equal(hits[0]?.maxContextTokens, 131072);
  assert.ok(calls.length >= 2, "应尝试过多个端点候选");
});

test("失败静默：非 2xx / 非 JSON / 抛错 一律返回空数组且不抛", async () => {
  const unauthorized = (async () => jsonResponse({ error: "nope" }, false)) as unknown as typeof fetch;
  assert.deepEqual(
    await probeProviderModelWindows({
      provider: "p",
      protocol: "openai",
      baseUrl: "https://p.test",
      fetchImpl: unauthorized,
    }),
    [],
  );

  const notJson = (async () =>
    ({ ok: true, status: 200, text: async () => "<html>hi</html>" }) as unknown as Response) as unknown as typeof fetch;
  assert.deepEqual(
    await probeProviderModelWindows({
      provider: "p",
      protocol: "openai",
      baseUrl: "https://p.test",
      fetchImpl: notJson,
    }),
    [],
  );

  const throws = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(
    await probeProviderModelWindows({
      provider: "p",
      protocol: "openai",
      baseUrl: "https://p.test",
      fetchImpl: throws,
    }),
    [],
  );
});

test("响应无窗口事实时不写入任何条目", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-window-probe-"));
  try {
    const store = new ModelWindowStore(join(dir, "model-windows.json"));
    const fetchImpl = (async () =>
      jsonResponse({ data: [{ id: "plain", object: "model" }] })) as unknown as typeof fetch;
    const result = await probeAndRecordProviderModelWindows({
      provider: "p",
      protocol: "openai",
      baseUrl: "https://p.test",
      store,
      fetchImpl,
    });
    assert.equal(result.recorded, 0);
    assert.deepEqual(store.read().entries, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
