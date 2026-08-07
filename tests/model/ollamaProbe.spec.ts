import assert from "node:assert/strict";
import test from "node:test";
import {
  getCachedOllamaModels,
  ollamaOrigin,
  probeOllamaInstalledModels,
  probeOllamaModelsCached,
} from "../../src/model/ollama/probe.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("ollamaOrigin strips the /v1 path segment", () => {
  assert.equal(ollamaOrigin("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(ollamaOrigin("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
});

test("probes native /api/tags first and maps model names with context length", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    calls.push(String(input));
    return jsonResponse({
      models: [
        { name: "qwen3:0.6b", details: { context_length: 40_960 } },
        { name: "llama3.1:8b", details: { context_length: 131_072 } },
        { name: "bge-m3", details: {} },
      ],
    });
  };

  const models = await probeOllamaInstalledModels("http://localhost:11434/v1", { fetchImpl });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("/api/tags"), `expected /api/tags, got ${calls[0]}`);
  assert.deepEqual(models, [
    { id: "qwen3:0.6b", displayName: "qwen3:0.6b", contextLength: 40_960 },
    { id: "llama3.1:8b", displayName: "llama3.1:8b", contextLength: 131_072 },
    { id: "bge-m3", displayName: "bge-m3" },
  ]);
});

test("falls back to OpenAI-compatible /v1/models when /api/tags is unavailable", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/tags")) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse({
      object: "list",
      data: [{ id: "qwen3:8b", display_name: "Qwen3 8B" }, { id: "models/bge-m3" }],
    });
  };

  const models = await probeOllamaInstalledModels("http://localhost:11434/v1", { fetchImpl });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith("/v1/models"), `expected /v1/models fallback, got ${calls[1]}`);
  assert.deepEqual(models, [
    { id: "qwen3:8b", displayName: "Qwen3 8B" },
    { id: "bge-m3", displayName: "bge-m3" },
  ]);
});

test("returns an empty list instead of throwing when Ollama is unreachable", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };

  const models = await probeOllamaInstalledModels("http://localhost:11434/v1", { fetchImpl });
  assert.deepEqual(models, []);
});

test("caches probe results and serves them synchronously", async () => {
  const url = "http://ollama-cache-test:11434/v1";
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse({ models: [{ name: "qwen3:32b" }] });
  };

  assert.equal(getCachedOllamaModels(url), null);
  const probed = await probeOllamaModelsCached(url, { fetchImpl });
  assert.deepEqual(probed, [{ id: "qwen3:32b", displayName: "qwen3:32b" }]);

  const cached = getCachedOllamaModels(url);
  assert.deepEqual(cached, [{ id: "qwen3:32b", displayName: "qwen3:32b" }]);

  // in-flight / cache 命中时不再发起网络请求
  await probeOllamaModelsCached(url, { fetchImpl });
  assert.equal(callCount, 1);
});

test("serves stale cached models after TTL expiry instead of returning null", async () => {
  const url = "http://ollama-stale-test:11434/v1";
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse({ models: [{ name: "qwen3:32b" }] });
  };

  await probeOllamaModelsCached(url, { fetchImpl });
  assert.equal(callCount, 1);

  // 伪造时间越过 60s TTL
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    fakeNow += 61_000;
    // 过期后同步读取仍返回 stale 数据（而非 null）——避免 config diff
    // 在「有探测模型 / 无探测模型」之间摆动导致每次 reload 判变。
    const stale = getCachedOllamaModels(url);
    assert.deepEqual(stale, [{ id: "qwen3:32b", displayName: "qwen3:32b" }]);
  } finally {
    Date.now = realNow;
  }
});

test("probeOllamaModelsCached re-probes stale cache instead of returning it forever", async () => {
  const url = "http://ollama-reprobe-test:11434/v1";
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse({ models: [{ name: "qwen3:32b" }] });
  };

  await probeOllamaModelsCached(url, { fetchImpl });
  assert.equal(callCount, 1);

  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    fakeNow += 61_000;
    // stale 缓存存在时，probeOllamaModelsCached 仍应发起真实探测
    const models = await probeOllamaModelsCached(url, { fetchImpl });
    assert.deepEqual(models, [{ id: "qwen3:32b", displayName: "qwen3:32b" }]);
    assert.equal(callCount, 2);
  } finally {
    Date.now = realNow;
  }
});
