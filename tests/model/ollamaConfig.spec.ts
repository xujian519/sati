import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRequest, parseModelConfig } from "../../src/model/index.js";
import { probeOllamaModelsCached } from "../../src/model/ollama/probe.js";
import type { CanonicalModelRequest } from "../../src/model/index.js";

test("Ollama provider does not require apiKey and uses OpenAI protocol defaults", () => {
  const config = parseModelConfig({
    providers: {
      ollama: {
        models: {
          "qwen3:0.6b": {},
        },
      },
    },
  });

  const provider = config.providers.ollama;
  assert.equal(provider.protocol, "openai");
  assert.equal(provider.url, "http://localhost:11434/v1");
  assert.equal(provider.apiKey, "ollama");
  // 模型能力不再来自写死的 catalog 条目，回落 OpenAI 协议默认值。
  assert.equal(provider.models["qwen3:0.6b"].capabilities.supportsStreaming, true);
  assert.equal(provider.models["qwen3:0.6b"].capabilities.supportsToolUse, true);
});

test("Ollama provider with empty models resolves instead of failing", () => {
  // 用户不手写模型 id：空 models 应可解析（运行时自动识别已安装模型）。
  // 使用独立 URL 避免共享探测缓存影响断言（缓存未命中 → 空列表）。
  const config = parseModelConfig({
    providers: {
      ollama: {
        url: "http://ollama-empty-models:11434/v1",
        models: {},
      },
    },
  });

  const provider = config.providers.ollama;
  assert.equal(provider.protocol, "openai");
  assert.equal(provider.url, "http://ollama-empty-models:11434/v1");
  assert.deepEqual(Object.keys(provider.models), []);
});

test("Ollama provider merges probed models with explicit config, config wins on conflict", async () => {
  // 预热探测缓存：模拟 Ollama 已安装 qwen3:32b（context 262144）。
  await probeOllamaModelsCached("http://localhost:11434/v1", {
    fetchImpl: async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3:32b", details: { context_length: 262_144 } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  // 配置里显式声明了 qwen3:0.6b：合并后两者都在，且探测模型的
  // maxContextTokens 来自 tags 的 context_length（而非协议默认 128k）。
  const config = parseModelConfig({
    providers: {
      ollama: {
        url: "http://localhost:11434/v1",
        models: { "qwen3:0.6b": {} },
      },
    },
  });

  const provider = config.providers.ollama;
  assert.deepEqual(Object.keys(provider.models).sort(), ["qwen3:0.6b", "qwen3:32b"]);
  assert.equal(provider.models["qwen3:32b"].capabilities.maxContextTokens, 262_144);
  assert.equal(provider.models["qwen3:32b"].capabilities.supportsStreaming, true);
  // 配置显式声明的模型保留（未探测到也不被丢弃）
  assert.ok(provider.models["qwen3:0.6b"]);
});

test("Ollama provider builds OpenAI-compatible chat completions body", () => {
  const config = parseModelConfig({
    providers: {
      ollama: {
        models: {
          "llama3.1:8b": {},
        },
      },
    },
  });

  const request: CanonicalModelRequest = {
    provider: "ollama",
    model: "llama3.1:8b",
    stream: true,
    systemPrompt: "You are concise.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };

  const body = buildModelRequest(request, config) as Record<string, unknown>;

  assert.equal(body.model, "llama3.1:8b");
  assert.equal(body.stream, true);
  // 模型能力不再来自写死的 catalog 条目：maxOutputTokens 回落协议默认 65536。
  assert.equal(body.max_tokens, 65536);
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are concise." },
    { role: "user", content: "hello" },
  ]);
});
