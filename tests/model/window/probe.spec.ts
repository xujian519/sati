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
import type { ModelConfig } from "../../../src/model/protocol/canonical.js";
import {
  buildModelWindowProbeHeaders,
  isModelWindowProbeEnabled,
  probeAndRecordProviderModelWindows,
  probeProviderModelWindows,
  warmModelWindowProbes,
} from "../../../src/model/window/probe.js";
import { ModelWindowStore, modelWindowKey } from "../../../src/model/window/store.js";

const NOW = "2026-09-19T00:00:00.000Z";

/** 最小 ModelConfig：只为预热入口服务（字段齐全即可，无 as unknown as）。 */
function modelConfig(urls: Record<string, string>): ModelConfig {
  const providers: ModelConfig["providers"] = {};
  for (const [id, url] of Object.entries(urls)) {
    providers[id] = {
      id,
      protocol: "openai",
      url,
      apiKey: "k",
      headers: {},
      models: {},
    };
  }
  return { providers };
}

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
    const entry = store.read().entries[modelWindowKey("openrouter", "vendor/model-a")];
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

// ---------------------------------------------------------------------------
// 自动探测开关与预热入口
// ---------------------------------------------------------------------------

test("开关解析：1/true/yes/on 为开，其余为关", () => {
  for (const on of ["1", "true", "TRUE", "yes", "on", " On "]) {
    assert.equal(isModelWindowProbeEnabled({ SATI_MODEL_WINDOW_PROBE: on }), true, `${on} 应视为开`);
  }
  for (const off of [undefined, "", "0", "false", "no", "off", "maybe"]) {
    assert.equal(
      isModelWindowProbeEnabled(off === undefined ? {} : { SATI_MODEL_WINDOW_PROBE: off }),
      false,
      `${String(off)} 应视为关`,
    );
  }
});

test("默认关：预热不发任何请求（离线/测试环境零网络副作用）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-window-warm-"));
  try {
    let called = 0;
    warmModelWindowProbes({
      model: modelConfig({ relay: "https://relay.test/v1" }),
      storePath: join(dir, "model-windows.json"),
      env: {},
      fetchImpl: (async () => {
        called += 1;
        return jsonResponse({ data: [{ id: "m", context_length: 131072 }] });
      }) as unknown as typeof fetch,
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(called, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("开启后：非 ollama provider 被探测并写入覆盖层，ollama 跳过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-window-warm-"));
  try {
    const storePath = join(dir, "model-windows.json");
    const calls: string[] = [];
    warmModelWindowProbes({
      model: modelConfig({ relay: "https://relay.test/v1", ollama: "http://127.0.0.1:11434/v1" }),
      storePath,
      env: { SATI_MODEL_WINDOW_PROBE: "1" },
      now: () => new Date("2026-09-19T00:00:00.000Z"),
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return jsonResponse({ data: [{ id: "m", context_length: 131072 }] });
      }) as unknown as typeof fetch,
    });

    const store = new ModelWindowStore(storePath);
    for (let i = 0; i < 100 && store.read().entries[modelWindowKey("relay", "m")] === undefined; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.equal(calls.length, 1, "只应探测一次（ollama 跳过）");
    assert.equal(calls[0]?.startsWith("https://relay.test"), true);
    assert.equal(store.read().entries[modelWindowKey("relay", "m")]?.maxContextTokens, 131072);
    assert.equal(store.read().entries[modelWindowKey("relay", "m")]?.source, "probe");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
