import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRerankClient, RerankRequestError, resolveRerankClient } from "../../../src/model/embedding/rerank.js";
import type { ModelConfig } from "../../../src/model/protocol/canonical.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

type FetchCall = { url: string; init: RequestInit };
const fetchCalls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    fetchCalls.push(call);
    return handler(call);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchCalls.length = 0;
});

describe("createRerankClient", () => {
  it("POST /rerank，body 为 { query, texts }，解析 { scores }（TEI 格式）", async () => {
    mockFetch(() => jsonResponse({ scores: [0.1, 0.9, 0.5] }));
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    const results = await client.rerank("query", ["doc1", "doc2", "doc3"]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.url, "http://localhost:8080/rerank");
    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { query: string; texts: string[] };
    assert.equal(body.query, "query");
    assert.deepEqual(body.texts, ["doc1", "doc2", "doc3"]);
    // 按分数降序，返回原下标
    assert.deepEqual(results, [
      { index: 1, score: 0.9 },
      { index: 2, score: 0.5 },
      { index: 0, score: 0.1 },
    ]);
  });

  it("兼容 Jina/Cohere 风格 { results: [{ index, relevance_score }] }", async () => {
    mockFetch(() =>
      jsonResponse({
        results: [
          { index: 2, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.6 },
        ],
      }),
    );
    const client = createRerankClient({ baseUrl: "http://localhost:8080", model: "bge-reranker-v2-m3" });
    const results = await client.rerank("q", ["a", "b", "c"]);
    assert.deepEqual(results, [
      { index: 2, score: 0.8 },
      { index: 1, score: 0.6 },
      { index: 0, score: 0.2 },
    ]);
    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { model: string };
    assert.equal(body.model, "bge-reranker-v2-m3");
  });

  it("style=jina 时 body 为 { query, documents } + model（oMLX /v1/rerank）", async () => {
    mockFetch(() =>
      jsonResponse({
        results: [
          { index: 1, relevance_score: 0.9, document: { text: "b" } },
          { index: 0, relevance_score: 0.1, document: { text: "a" } },
        ],
      }),
    );
    const client = createRerankClient({
      baseUrl: "http://localhost:8000/v1",
      model: "Qwen3-Reranker-4B-4bit-MLX",
      style: "jina",
    });
    const results = await client.rerank("创造性判断", ["a", "b"]);
    assert.equal(fetchCalls[0]?.url, "http://localhost:8000/v1/rerank", "baseUrl 拼接 /rerank");
    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as {
      query: string;
      documents: string[];
      model: string;
    };
    assert.equal(body.query, "创造性判断");
    assert.deepEqual(body.documents, ["a", "b"], "jina 风格应使用 documents 字段");
    assert.equal(body.model, "Qwen3-Reranker-4B-4bit-MLX");
    assert.deepEqual(results, [
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
  });

  it("style=tei（默认）保持 { query, texts } 兼容既有行为", async () => {
    mockFetch(() => jsonResponse({ scores: [0.5, 0.8] }));
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    await client.rerank("q", ["a", "b"]);
    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { query: string; texts: string[]; model?: string };
    assert.deepEqual(body.texts, ["a", "b"]);
    assert.equal(body.model, undefined, "tei 风格未配 model 时不发送");
  });

  it("topN 限制返回条数", async () => {
    mockFetch(() => jsonResponse({ scores: [0.1, 0.9, 0.5] }));
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    const results = await client.rerank("q", ["a", "b", "c"], 2);
    assert.deepEqual(results, [
      { index: 1, score: 0.9 },
      { index: 2, score: 0.5 },
    ]);
  });

  it("空文档直接返回空数组", async () => {
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    assert.deepEqual(await client.rerank("q", []), []);
    assert.equal(fetchCalls.length, 0);
  });

  it("非 200 抛 RerankRequestError", async () => {
    mockFetch(() => jsonResponse({ error: "model not loaded" }, 503));
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    await assert.rejects(
      async () => client.rerank("q", ["a"]),
      (error: unknown) => {
        assert.ok(error instanceof RerankRequestError);
        assert.equal(error.status, 503);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it("style=tei 遇到 422 缺 documents 时自动降级 jina 重试（oMLX /v1 场景）", async () => {
    let calls = 0;
    mockFetch(call => {
      calls += 1;
      if (calls === 1) {
        // 第一次按 tei 发送 → oMLX 422 拒绝（缺 documents/model）
        return jsonResponse(
          {
            error: {
              message: "body -> documents: Field required; body -> model: Field required",
              type: "invalid_request_error",
            },
          },
          422,
        );
      }
      // 降级后按 jina 风格发送 → 成功
      const body = JSON.parse(String(call.init.body)) as {
        query: string;
        documents?: string[];
        texts?: string[];
        model?: string;
      };
      assert.equal(body.query, "创造性判断");
      assert.deepEqual(body.documents, ["a", "b"], "降级请求应使用 documents 字段");
      assert.equal(body.texts, undefined, "降级请求不应再使用 texts");
      assert.equal(body.model, "Qwen3-Reranker-4B-4bit-MLX");
      return jsonResponse({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
        ],
      });
    });
    const client = createRerankClient({
      baseUrl: "http://localhost:8010/v1",
      model: "Qwen3-Reranker-4B-4bit-MLX",
      // 未显式指定 style → 默认 tei，触发降级
    });
    const results = await client.rerank("创造性判断", ["a", "b"]);
    assert.equal(calls, 2);
    assert.deepEqual(results, [
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
  });

  it("style=tei 非 422 错误不降级（保持原错误）", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return jsonResponse({ error: "model not loaded" }, 503);
    });
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    await assert.rejects(
      async () => client.rerank("q", ["a"]),
      (error: unknown) => {
        assert.ok(error instanceof RerankRequestError);
        assert.equal(error.status, 503);
        return true;
      },
    );
    assert.equal(calls, 1, "503 不应触发降级重试");
  });

  it("style=tei 422 但错误不含 documents/model 不降级", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return jsonResponse({ error: { message: "body -> query: Field required" } }, 422);
    });
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    await assert.rejects(async () => client.rerank("q", ["a"]), RerankRequestError);
    assert.equal(calls, 1);
  });

  it("style=tei 响应条数不匹配抛错", async () => {
    mockFetch(() => jsonResponse({ scores: [0.9] }));
    const client = createRerankClient({ baseUrl: "http://localhost:8080" });
    await assert.rejects(async () => client.rerank("q", ["a", "b"]), RerankRequestError);
  });

  it("healthCheck 成功/失败", async () => {
    mockFetch(() => jsonResponse({ scores: [0.5] }));
    const ok = createRerankClient({ baseUrl: "http://localhost:8080" });
    assert.equal(await ok.healthCheck(), true);

    mockFetch(() => {
      throw new TypeError("down");
    });
    const down = createRerankClient({ baseUrl: "http://localhost:8080" });
    assert.equal(await down.healthCheck(), false);
  });
});

describe("resolveRerankClient", () => {
  const modelConfig: ModelConfig = {
    providers: {
      tei: { id: "tei", protocol: "openai", url: "http://localhost:8080", apiKey: "", models: {}, headers: {} },
    },
  };

  it("未配置/disabled 返回 undefined", () => {
    assert.equal(resolveRerankClient(undefined, modelConfig), undefined);
    assert.equal(resolveRerankClient({ enabled: false, provider: "tei" }, modelConfig), undefined);
  });

  it("provider 形态构造客户端", () => {
    const client = resolveRerankClient({ enabled: true, provider: "tei", model: "bge-reranker-v2-m3" }, modelConfig);
    assert.ok(client);
  });

  it("未知 provider 返回 undefined + 诊断", () => {
    const diagnostics: PilotConfigDiagnostic[] = [];
    const client = resolveRerankClient({ enabled: true, provider: "ghost" }, modelConfig, diagnostics);
    assert.equal(client, undefined);
    assert.equal(diagnostics[0]?.code, "CONFIG_MEMORY_RERANK_PROVIDER_NOT_FOUND");
  });

  it("baseUrl 形态构造客户端", () => {
    const client = resolveRerankClient({ enabled: true, baseUrl: "http://localhost:8080" }, modelConfig);
    assert.ok(client);
  });

  it("provider 与 baseUrl 均缺返回 undefined + 诊断", () => {
    const diagnostics: Array<{
      code: string;
      severity: "warning";
      message: string;
      path: string;
      recoverable: boolean;
    }> = [];
    const client = resolveRerankClient({ enabled: true }, modelConfig, diagnostics);
    assert.equal(client, undefined);
    assert.equal(diagnostics[0]?.code, "CONFIG_MEMORY_RERANK_INVALID");
  });
});
