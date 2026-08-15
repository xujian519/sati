/**
 * 请求级 retryScope 集成测试（阶段四 T4.2）。
 *
 * AgentLoop 把 turnId 并入请求 metadata 后，streamModel 的 retryId 应在同一
 * turn 的全部请求间稳定（跨重试尝试、跨请求），不同 turn 不同。本测试以 mock
 * fetch 全量 429 驱动重试，验证 onRetryProgress 携带的 retryId 契约。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import {
  streamModel,
  type ModelStreamRetryProgress,
  type ModelTransport,
} from "../../../src/model/streaming/streamModel.js";

function makeConfig() {
  return parseModelConfig({
    providers: {
      openai: {
        apiKey: "sk-test",
        url: "https://api.openai.com/v1",
        retry: { baseDelayMs: 1, maxDelayMs: 2, jitter: 0, streamMaxRetries: 2 },
        models: { "gpt-4o-mini": {} },
      },
    },
  });
}

function makeRequest(turnId: string): CanonicalModelRequest {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    stream: true,
    metadata: { turnId },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

/** 始终返回 429（retryable）：驱动全部重试尝试，无需构造成功 SSE 流。 */
function makeRateLimitedFetch(): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ error: { message: "rate limit", type: "rate_limit_error" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
}

async function collectRetryIds(request: CanonicalModelRequest): Promise<string[]> {
  const progress: ModelStreamRetryProgress[] = [];
  for await (const _event of streamModel(request, makeConfig(), {
    fetch: makeRateLimitedFetch() as ModelTransport,
    onRetryProgress: p => progress.push(p),
  })) {
    // 全量 429：最终 yield 一个 error 事件后返回。
  }
  return progress.map(p => p.retryId);
}

test("retryScope：同一 turnId 的两次请求 retryId 稳定，不同 turnId 不同", async () => {
  const first = await collectRetryIds(makeRequest("turn-1"));
  assert.ok(first.length > 0, "应触发至少一次重试进度");
  const second = await collectRetryIds(makeRequest("turn-1"));
  assert.equal(second.length, first.length);
  // 同一 turn：两次请求的全部尝试共享同一 retryId。
  assert.equal(second[0], first[0]);

  const other = await collectRetryIds(makeRequest("turn-2"));
  assert.ok(other.length > 0);
  assert.notEqual(other[0], first[0]);
});
