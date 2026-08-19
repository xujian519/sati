import test from "node:test";
import assert from "node:assert/strict";
import { TokenAccountingRuntime } from "../../src/context/budget/TokenAccountingRuntime.js";
import type { CanonicalModelRequest, ModelConfig, ProviderConfig } from "../../src/model/index.js";

function stubFetch(handler: (url: string, init: RequestInit) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handler(String(input), init ?? {});
    return response as Response;
  }) as typeof fetch;
}

function makeProvider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "openai",
    protocol: "openai-responses",
    url: "https://api.openai.com/v1",
    apiKey: "test-key",
    headers: {},
    models: {
      "gpt-test": {
        id: "gpt-test",
        capabilities: {},
        multimodal: { input: ["text"] },
      },
    } as unknown as ProviderConfig["models"],
    ...overrides,
  };
}

function makeRuntime(provider: ProviderConfig, fetchImpl: typeof fetch): TokenAccountingRuntime {
  return new TokenAccountingRuntime({
    modelConfig: {
      providers: { openai: provider },
    } as unknown as ModelConfig,
    fetch: fetchImpl,
    // 关闭快速通道：本地估算不再拦截，强制走 provider count 路径。
    nearLimitRatio: 0,
  });
}

function makeRequest(providerId: string): CanonicalModelRequest {
  return {
    provider: providerId,
    model: "gpt-test",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
    systemPrompt: "You are a patent assistant.",
    tools: [
      {
        name: "patent_search",
        description: "search patents",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    stream: false,
  };
}

test("official OpenAI chat-protocol providers no longer hit the responses count endpoint", async () => {
  let calls = 0;
  const runtime = makeRuntime(
    makeProvider({ protocol: "openai" }),
    stubFetch((_url, _init) => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ input_tokens: 10 }) };
    }),
  );
  const result = await runtime.countRequestInput(makeRequest("openai"), { signal: undefined });
  assert.equal(result.source, "local");
  assert.equal(calls, 0);
});

test("official OpenAI responses providers count via the canonical request builder", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const runtime = makeRuntime(
    makeProvider({}),
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ input_tokens: 42, output_tokens: 3 }) };
    }),
  );
  const result = await runtime.countRequestInput(makeRequest("openai"), { signal: undefined });
  assert.equal(result.source, "provider");
  assert.equal(result.tokens, 42);
  assert.match(capturedUrl, /\/v1\/responses\/input_tokens$/);
  // Body 由 buildOpenAIResponsesRequest 直建：model 为请求模型、input 为
  // Responses 格式条目、instructions 承载 system prompt（不再走 chat→responses 手工转换）。
  assert.equal(capturedBody.model, "gpt-test");
  assert.ok(Array.isArray(capturedBody.input), "input must be a Responses input array");
  assert.equal(capturedBody.instructions, "You are a patent assistant.");
  assert.ok(Array.isArray(capturedBody.tools), "tools must be present");
  const input = capturedBody.input as Array<Record<string, unknown>>;
  assert.ok(
    input.some(item => item.role === "user"),
    "input carries user turns",
  );
});

test("responses count respects explicit request.outputSchema text format", async () => {
  let capturedBody: Record<string, unknown> = {};
  const runtime = makeRuntime(
    makeProvider({}),
    stubFetch((_url, init) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ input_tokens: 7 }) };
    }),
  );
  const request = makeRequest("openai");
  request.outputSchema = {
    name: "patent_summary",
    schema: { type: "object", properties: { title: { type: "string" } } },
    strict: true,
  };
  await runtime.countRequestInput(request, { signal: undefined });
  const text = capturedBody.text as { format?: { name?: string } } | undefined;
  assert.equal(text?.format?.name, "patent_summary");
});
