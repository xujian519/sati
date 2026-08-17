// llm-http 行为基线测试（从 llm-extraction.ts 拆出，行为等价）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGoogleGenerateContentUrl,
  buildProviderRequest,
  executeWithRetryRequest,
  normalizeGoogleModelId,
  normalizeProviderApi,
  shouldOmitTemperature,
} from "../../src/core/skills/llm-http.js";

const selection = { provider: "sati", model: "deepseek-v4-flash", api: "openai", baseUrl: "https://api.example.com" };

describe("normalizeProviderApi / shouldOmitTemperature / normalizeGoogleModelId", () => {
  it("gemini → google 归一", () => {
    assert.equal(normalizeProviderApi("GEMINI"), "google");
    assert.equal(normalizeProviderApi("openai"), "openai");
  });
  it("推理模型省略 temperature（deepseek-v4/kimi 系列）", () => {
    assert.equal(shouldOmitTemperature("deepseek-v4-flash"), true);
    assert.equal(shouldOmitTemperature("kimi-k2"), true);
    assert.equal(shouldOmitTemperature("claude-sonnet"), false);
  });
  it("gemini-3.x → preview 别名映射", () => {
    assert.equal(normalizeGoogleModelId("gemini-3-pro"), "gemini-3-pro-preview");
    assert.equal(normalizeGoogleModelId("google/gemini-3.1-flash"), "gemini-3-flash-preview");
    assert.equal(normalizeGoogleModelId("other-model"), "other-model");
  });
  it("buildGoogleGenerateContentUrl apiVersion 推断（v1/v1beta）", () => {
    const url = buildGoogleGenerateContentUrl("https://generativelanguage.googleapis.com/v1beta", "gemini-3-pro");
    assert.ok(url.includes("/v1beta/models/gemini-3-pro-preview:generateContent"));
    assert.ok(url.includes("generativelanguage.googleapis.com"));
  });
});

describe("buildProviderRequest 4 分支", () => {
  it("openai-responses 分支", () => {
    const { url, body, headers } = buildProviderRequest({
      apiType: "responses",
      selection: { ...selection, api: "openai-responses" },
      systemPrompt: "sys",
      userPrompt: "user",
      apiKey: "key",
    });
    assert.equal(url, "https://api.example.com/responses");
    assert.equal(headers.get("authorization"), "Bearer key");
    assert.deepEqual(body.input, [
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  });
  it("anthropic 分支（x-api-key + anthropic-version + max_tokens）", () => {
    const { url, body, headers } = buildProviderRequest({
      apiType: "anthropic",
      selection: { ...selection, api: "anthropic", model: "claude-sonnet-4-5" },
      systemPrompt: "sys",
      userPrompt: "user",
      apiKey: "key",
    });
    assert.equal(url, "https://api.example.com/v1/messages");
    assert.equal(headers.get("x-api-key"), "key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(body.max_tokens, 65536);
    assert.ok("temperature" in body, "claude 应携带 temperature");
  });
  it("google 分支（x-goog-api-key + responseMimeType）", () => {
    const { body, headers } = buildProviderRequest({
      apiType: "google",
      selection: { ...selection, api: "google", model: "gemini-3-pro" },
      systemPrompt: "sys",
      userPrompt: "user",
      apiKey: "key",
    });
    assert.equal(headers.get("x-goog-api-key"), "key");
    assert.equal(body.generationConfig?.responseMimeType, "application/json");
  });
  it("chat/completions 分支（response_format + stream:false）", () => {
    const { url, body, headers } = buildProviderRequest({
      apiType: "openai",
      selection,
      systemPrompt: "sys",
      userPrompt: "user",
      apiKey: "key",
    });
    assert.equal(url, "https://api.example.com/chat/completions");
    assert.equal(headers.get("authorization"), "Bearer key");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.stream, false);
    assert.equal(body.temperature, undefined, "deepseek-v4 推理模型 temperature 应为 undefined");
  });
  it("缺 baseUrl 抛错", () => {
    assert.throws(() =>
      buildProviderRequest({
        apiType: "openai",
        selection: { ...selection, baseUrl: undefined },
        systemPrompt: "sys",
        userPrompt: "user",
        apiKey: "key",
      }),
    );
  });
});

describe("executeWithRetryRequest", () => {
  const request = {
    url: "https://api.example.com/chat/completions",
    headers: new Headers({ "content-type": "application/json" }),
    body: { model: "m" },
    requestLabel: "Test call",
  };

  it("成功一次返回", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const response = await executeWithRetryRequest(request);
      assert.equal(response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("可重试状态码（429）重试后成功", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1 ? new Response("rate limited", { status: 429 }) : new Response("{}", { status: 200 });
    };
    try {
      const response = await executeWithRetryRequest(request);
      assert.equal(response.status, 200);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("非重试码（400）立即抛错", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("bad", { status: 400 });
    };
    try {
      await assert.rejects(executeWithRetryRequest(request), /request failed \(400\)/);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("超时抛 timeout 错误", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      // 模拟 AbortSignal 触发 abort
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new DOMException("aborted", "AbortError");
          reject(error);
        });
      });
    };
    try {
      await assert.rejects(executeWithRetryRequest({ ...request, timeoutMs: 20 }), /timed out after 20ms/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
