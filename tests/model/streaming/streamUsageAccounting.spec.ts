/**
 * 流式 usage 计量与降级（#847）。
 *
 * 背景：OpenAI 协议下**流式响应默认不返回 usage**，除非显式请求
 * `stream_options.include_usage`。缺这一项时 provider 侧 token 计量恒为空，
 * 「调用成本」类结论无据——此前 live 评测基线只能标注「token：API 未返回」。
 *
 * 本组用例覆盖三件事：
 * 1. 流式请求下发 `stream_options.include_usage`（非流式不下发）；
 * 2. usage 事件能被解析出来（端点回 usage 时 token 真的可计量）；
 * 3. 端点不认 `stream_options` 而回 400 时自动降级重试（去掉该字段后成功），
 *    且错误体未点名 `stream_options` 时**不**降级（真实参数错误不掩盖）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { buildOpenAIRequest } from "../../../src/model/providers/openai/request.js";
import { streamModel } from "../../../src/model/streaming/streamModel.js";

function createConfig() {
  return parseModelConfig({
    providers: {
      test: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 0, baseDelayMs: 1 },
        models: { "test-model": {} },
      },
    },
  });
}

function createRequest(): CanonicalModelRequest {
  return {
    provider: "test",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function sse(data: string): Response {
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function readBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

test("流式请求下发 stream_options.include_usage，非流式不下发", () => {
  const config = createConfig();
  const provider = config.providers.test!;
  const model = provider.models["test-model"]!;

  const streaming = buildOpenAIRequest({ ...createRequest(), stream: true }, model, provider);
  assert.deepEqual(streaming.stream_options, { include_usage: true });

  const nonStreaming = buildOpenAIRequest({ ...createRequest(), stream: false }, model, provider);
  assert.equal(nonStreaming.stream_options, undefined);
});

test("端点返回 usage 时，流式事件带出可计量的 token", async () => {
  const config = createConfig();
  const events = await collect(
    streamModel(createRequest(), config, {
      fetch: async () =>
        sse(
          [
            'data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"}}]}',
            'data: {"id":"1","choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":120,"completion_tokens":30}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
    }),
  );

  const usage = events.find(event => event.type === "usage");
  assert.ok(usage, "应产出 usage 事件");
  assert.equal(usage.type === "usage" ? usage.usage.inputTokens : undefined, 120);
  assert.equal(usage.type === "usage" ? usage.usage.outputTokens : undefined, 30);
});

test("端点不认 stream_options 回 400 时降级重试（去掉该字段后成功）", async () => {
  const config = createConfig();
  const bodies: Array<Record<string, unknown>> = [];

  const events = await collect(
    streamModel(createRequest(), config, {
      fetch: async (_input, init) => {
        const body = readBody(init);
        bodies.push(body);
        if (body.stream_options !== undefined) {
          return new Response(
            JSON.stringify({ error: { message: "Unknown parameter: stream_options", type: "invalid_request_error" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return sse('data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      },
    }),
  );

  assert.equal(bodies.length, 2, "应先带 stream_options 试一次，再降级重试一次");
  assert.deepEqual(bodies[0]?.stream_options, { include_usage: true });
  assert.equal(bodies[1]?.stream_options, undefined, "降级请求应已去掉 stream_options");
  assert.equal(
    events.some(event => event.type === "error"),
    false,
    "降级后应正常完成，不产出 error 事件",
  );
});

test("400 错误体未点名 stream_options 时不降级（真实参数错误不掩盖）", async () => {
  const config = createConfig();
  let requests = 0;

  const events = await collect(
    streamModel(createRequest(), config, {
      fetch: async () => {
        requests++;
        return new Response(
          JSON.stringify({ error: { message: "Invalid value for max_tokens", type: "invalid_request_error" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    }),
  );

  assert.equal(requests, 1, "不应为了无关的 400 而重试");
  assert.equal(
    events.some(event => event.type === "error"),
    true,
    "真实参数错误应如实上抛",
  );
});
