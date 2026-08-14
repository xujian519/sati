import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelRequest } from "../../src/model/index.js";
import {
  TokenAccountingRuntime,
  type TokenAccountingRuntimeOptions,
} from "../../src/context/budget/TokenAccountingRuntime.js";

/**
 * TokenAccountingRuntime 快速通道测试：
 * 本地估算显著低于可用窗口时跳过 provider count_tokens 网络调用（每 turn 一次的
 * 全量序列化 + 网络往返），仅当估算逼近窗口时才精确计数。
 */

function makeFetchSpy() {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push({ url: String(input) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ input_tokens: 123, output_tokens: 5 }),
      text: async () => JSON.stringify({ input_tokens: 123, output_tokens: 5 }),
    } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeOptions(overrides: Partial<TokenAccountingRuntimeOptions> = {}): TokenAccountingRuntimeOptions {
  return {
    modelConfig: {
      providers: {
        anthropic: {
          id: "anthropic",
          protocol: "anthropic",
          url: "https://api.anthropic.test",
          apiKey: "test-key",
          headers: {},
          models: {
            "claude-test": {
              id: "claude-test",
              capabilities: {},
              multimodal: { supported: false, maxImagesPerRequest: 0 },
            },
          },
        },
      },
    } as never,
    ...overrides,
  } as TokenAccountingRuntimeOptions;
}

function makeRequest(): CanonicalModelRequest {
  return {
    provider: "anthropic",
    model: "claude-test",
    messages: [{ role: "user", content: [{ type: "text", text: "你好，请介绍一下专利侵权赔偿标准。" }] }],
    systemPrompt: "你是一个专利法专家。",
    tools: [],
    stream: false,
  } as CanonicalModelRequest;
}

test("快速通道：本地估算低于窗口阈值时不调用 provider count（无网络往返）", async () => {
  const { calls, fetchImpl } = makeFetchSpy();
  const runtime = new TokenAccountingRuntime(makeOptions({ fetch: fetchImpl }));
  const snapshot = await runtime.evaluateRequestBudget(makeRequest(), {
    maxContextTokens: 200_000,
    reservedOutputTokens: 8_192,
    usePadding: true,
  });
  assert.equal(calls.length, 0, "本地估算显著低于窗口时应跳过 provider count_tokens");
  assert.equal(snapshot.source, "local");
  assert.equal(snapshot.exact, false);
  assert.equal(snapshot.state, "ok");
});

test("逼近窗口阈值时仍走 provider count（精确计数保真）", async () => {
  const { calls, fetchImpl } = makeFetchSpy();
  const runtime = new TokenAccountingRuntime(makeOptions({ fetch: fetchImpl }));
  // 极小的窗口迫使本地估算超过阈值，从而触发 provider count
  const snapshot = await runtime.evaluateRequestBudget(makeRequest(), {
    maxContextTokens: 10,
    reservedOutputTokens: 0,
    usePadding: true,
  });
  assert.ok(calls.length >= 1, "估算逼近窗口时应调用 provider count_tokens");
  assert.equal(snapshot.source, "provider");
  assert.equal(snapshot.exact, true);
});

test("nearLimitRatio=0 时始终走 provider count", async () => {
  const { calls, fetchImpl } = makeFetchSpy();
  const runtime = new TokenAccountingRuntime(makeOptions({ fetch: fetchImpl, nearLimitRatio: 0 }));
  await runtime.evaluateRequestBudget(makeRequest(), {
    maxContextTokens: 200_000,
    reservedOutputTokens: 8_192,
    usePadding: true,
  });
  assert.ok(calls.length >= 1, "nearLimitRatio=0 应禁用快速通道");
});

test("nearLimitRatio=1 时始终走快速通道（从不调用 provider count）", async () => {
  const { calls, fetchImpl } = makeFetchSpy();
  const runtime = new TokenAccountingRuntime(makeOptions({ fetch: fetchImpl, nearLimitRatio: 1 }));
  await runtime.evaluateRequestBudget(makeRequest(), {
    maxContextTokens: 200_000,
    reservedOutputTokens: 8_192,
    usePadding: true,
  });
  assert.equal(calls.length, 0, "nearLimitRatio=1 应始终快速通道");
});

test("快速通道快照的 budgetTokens 采用 padding 估算且不小于 tokens", async () => {
  const { fetchImpl } = makeFetchSpy();
  const runtime = new TokenAccountingRuntime(makeOptions({ fetch: fetchImpl }));
  const snapshot = await runtime.evaluateRequestBudget(makeRequest(), {
    maxContextTokens: 200_000,
    reservedOutputTokens: 8_192,
    usePadding: true,
  });
  assert.ok(snapshot.tokens > 0);
  assert.ok((snapshot.budgetTokens ?? snapshot.tokens) >= snapshot.tokens, "budgetTokens 应不小于 tokens");
});

test("可复算性：同一请求两次本地估算结果严格相等（纯函数）", async () => {
  const { fetchImpl } = makeFetchSpy();
  const runtime = new TokenAccountingRuntime(makeOptions({ fetch: fetchImpl }));
  const request = makeRequest();
  const first = await runtime.evaluateRequestBudget(request, {
    maxContextTokens: 200_000,
    reservedOutputTokens: 8_192,
    usePadding: true,
  });
  const second = await runtime.evaluateRequestBudget(request, {
    maxContextTokens: 200_000,
    reservedOutputTokens: 8_192,
    usePadding: true,
  });
  assert.equal(first.tokens, second.tokens, "同一请求的本地估算必须可复算");
  assert.equal(first.budgetTokens, second.budgetTokens);
});

test("可复算性：estimateRequestInput 对相同请求稳定（含工具 schema 与 system prompt）", () => {
  const runtime = new TokenAccountingRuntime(makeOptions({ fetch: makeFetchSpy().fetchImpl }));
  const request: CanonicalModelRequest = {
    provider: "anthropic",
    model: "claude-test",
    messages: [
      { role: "user", content: [{ type: "text", text: "对权利要求 1 进行创造性分析，引用审查指南第二部分第四章。" }] },
    ],
    systemPrompt: "你是 Sati 专利智能体，回答须引用法条。",
    tools: [
      {
        name: "patent_search",
        description: "检索专利文献。",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    stream: false,
  } as CanonicalModelRequest;
  assert.equal(
    runtime.estimateRequestInput(request, { usePadding: true }),
    runtime.estimateRequestInput(request, { usePadding: true }),
  );
});

test("guardBand：估算落在 ratio 与 ratio-guardBand 之间时走精确计数（防漏触发）", async () => {
  const { calls, fetchImpl } = makeFetchSpy();
  // 显式注入阈值参数，避免依赖默认值与文本长度巧合。
  const runtime = new TokenAccountingRuntime(
    makeOptions({ fetch: fetchImpl, nearLimitRatio: 0.9, nearLimitGuardBand: 0.05 }),
  );
  const longText = "专利侵权判定应当遵循全面覆盖原则与等同原则。".repeat(40);
  const request: CanonicalModelRequest = {
    provider: "anthropic",
    model: "claude-test",
    messages: [{ role: "user", content: [{ type: "text", text: longText }] }],
    systemPrompt: "你是 Sati 专利智能体。",
    tools: [],
    stream: false,
  } as CanonicalModelRequest;
  const localTokens = runtime.estimateRequestInput(request, { usePadding: true });
  // 阈值：无 guardBand = 0.9W，有 guardBand = 0.85W。取窗口使 localTokens 恰落
  // (0.85W, 0.9W]：有 guardBand 时走精确计数，无 guardBand 时走快速通道。
  const window = Math.ceil(localTokens / 0.9);

  await runtime.evaluateRequestBudget(request, { maxContextTokens: window, reservedOutputTokens: 0, usePadding: true });
  assert.ok(calls.length >= 1, "估算落在 guardBand 区间内时须走 provider count_tokens");

  // 对照组：同一窗口无 guardBand（阈值 0.9）→ 快速通道，零网络调用。
  const { calls: noBandCalls, fetchImpl: noBandFetch } = makeFetchSpy();
  const noBandRuntime = new TokenAccountingRuntime(
    makeOptions({ fetch: noBandFetch, nearLimitRatio: 0.9, nearLimitGuardBand: 0 }),
  );
  await noBandRuntime.evaluateRequestBudget(request, {
    maxContextTokens: window,
    reservedOutputTokens: 0,
    usePadding: true,
  });
  assert.equal(noBandCalls.length, 0, "无 guardBand 时同一窗口走快速通道");
});
