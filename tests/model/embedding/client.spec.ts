import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createOpenAiEmbeddingClient, EmbeddingRequestError } from "../../../src/model/embedding/client.js";

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

describe("createOpenAiEmbeddingClient", () => {
  it("POST 到 {baseUrl}/embeddings，body 含 model 与 input", async () => {
    mockFetch(() => jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }));
    const client = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1/",
      apiKey: "ollama",
      model: "bge-m3",
    });
    await client.embed(["你好"]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.url, "http://localhost:11434/v1/embeddings");
    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { model: string; input: string[] };
    assert.equal(body.model, "bge-m3");
    assert.deepEqual(body.input, ["你好"]);
    assert.equal(
      (fetchCalls[0]!.init.headers as Record<string, string> | undefined)?.["authorization"],
      "Bearer ollama",
    );
  });

  it("解析向量并推断维度", async () => {
    mockFetch(() => jsonResponse({ data: [{ embedding: [1, 2, 3, 4] }] }));
    const client = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "bge-m3",
    });
    const result = await client.embed(["a"]);
    assert.deepEqual(result, [[1, 2, 3, 4]]);
    assert.equal(client.dimensions, 4);
  });

  it("按 batchSize 分批请求", async () => {
    mockFetch(call => {
      const body = JSON.parse(String(call.init.body)) as { input: string[] };
      return jsonResponse({ data: body.input.map((_, index) => ({ embedding: [index + 1] })) });
    });
    const client = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "m",
      batchSize: 2,
    });
    const result = await client.embed(["a", "b", "c", "d", "e"]);
    assert.equal(result.length, 5);
    assert.equal(fetchCalls.length, 3); // 2+2+1
  });

  it("非 200 抛 EmbeddingRequestError（含 status）", async () => {
    mockFetch(() => jsonResponse({ error: "model not found" }, 404));
    const client = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "nope",
    });
    await assert.rejects(
      async () => client.embed(["x"]),
      (error: unknown) => {
        assert.ok(error instanceof EmbeddingRequestError);
        assert.equal(error.status, 404);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it("响应条数不匹配抛错", async () => {
    mockFetch(() => jsonResponse({ data: [{ embedding: [1] }] }));
    const client = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "m",
    });
    await assert.rejects(async () => client.embed(["a", "b"]), EmbeddingRequestError);
  });

  it("网络异常包装为 EmbeddingRequestError（可重试）", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "m",
    });
    await assert.rejects(
      async () => client.embed(["x"]),
      (error: unknown) => {
        assert.ok(error instanceof EmbeddingRequestError);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it("healthCheck 成功/失败", async () => {
    mockFetch(() => jsonResponse({ data: [{ embedding: [1] }] }));
    const ok = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "m",
    });
    assert.equal(await ok.healthCheck(), true);

    mockFetch(() => {
      throw new TypeError("down");
    });
    const down = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "m",
    });
    assert.equal(await down.healthCheck(), false);
  });

  it("空输入直接返回空数组，不发请求", async () => {
    mockFetch(() => jsonResponse({ data: [] }));
    const client = createOpenAiEmbeddingClient({
      apiType: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "m",
    });
    assert.deepEqual(await client.embed([]), []);
    assert.equal(fetchCalls.length, 0);
  });
});
