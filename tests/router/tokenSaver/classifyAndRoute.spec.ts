import test from "node:test";
import assert from "node:assert/strict";
import { classifyAndRoute } from "../../../src/router/tokenSaver/classifyAndRoute.js";
import type { RouterTokenSaverConfig } from "../../../src/router/config/schema.js";
import { ModelProviderError, ModelRequestError } from "../../../src/model/index.js";
import type { CanonicalMessage, CanonicalModelResponse, ModelRuntime } from "../../../src/model/index.js";

const messages: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "请帮我分析这份专利的权利要求" }] },
];

const config: RouterTokenSaverConfig = {
  enabled: true,
  judge: { id: "judge/local", provider: "judge", model: "local" },
  defaultTier: "simple",
  tiers: {
    simple: { model: { id: "local/simple", provider: "local", model: "simple" } },
    complex: { model: { id: "local/complex", provider: "local", model: "complex" } },
  },
  judgeTimeoutMs: 500,
};

function runtimeWithComplete(
  complete: ModelRuntime["complete"],
  calls?: Array<{
    request: Parameters<ModelRuntime["complete"]>[0];
    options?: Parameters<ModelRuntime["complete"]>[1];
  }>,
): ModelRuntime {
  return {
    complete: (request: Parameters<ModelRuntime["complete"]>[0], options: Parameters<ModelRuntime["complete"]>[1]) => {
      calls?.push({ request, options });
      return complete(request, options);
    },
    stream: () => {
      throw new Error("stream is not exercised in tokenSaver tests");
    },
    getCapabilities: () => ({ maxContextTokens: 0 }),
    getMultimodal: () => ({ images: false }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
}

function pendingUntilAbort(signal?: AbortSignal): Promise<CanonicalModelResponse> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

function tierResponse(tier: string): CanonicalModelResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: `<tier>${tier}</tier>` }],
    finishReason: "stop",
  };
}

test("judge 成功时返回解析出的 tier，且请求不带显式 temperature", async () => {
  const calls: Array<{
    request: Parameters<ModelRuntime["complete"]>[0];
    options?: Parameters<ModelRuntime["complete"]>[1];
  }> = [];
  const decision = await classifyAndRoute({
    config,
    messages,
    judgeRuntime: runtimeWithComplete(() => Promise.resolve(tierResponse("complex")), calls),
  });

  assert.equal(decision?.resolvedFrom, "judge");
  assert.equal(decision?.tier, "complex");
  assert.equal(decision?.failure, undefined);
  assert.equal(calls.length, 1);
  assert.equal("temperature" in calls[0]!.request, false);
});

test("judge 超时时中止请求并返回带诊断的 fallback", async () => {
  const calls: Array<{
    request: Parameters<ModelRuntime["complete"]>[0];
    options?: Parameters<ModelRuntime["complete"]>[1];
  }> = [];
  const decision = await classifyAndRoute({
    config,
    messages,
    judgeRuntime: runtimeWithComplete((_request, options) => pendingUntilAbort(options?.signal), calls),
  });

  assert.equal(decision?.resolvedFrom, "fallback");
  assert.equal(decision?.failureReason, "timeout");
  assert.deepEqual(decision?.failure, { reason: "timeout", attempts: 1, code: "judge_timeout" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options?.signal?.aborted, true);
});

test("外部中止信号触发时直接抛错，不降级为 fallback", async () => {
  const abortController = new AbortController();
  abortController.abort(new Error("turn cancelled"));
  const calls: Array<{
    request: Parameters<ModelRuntime["complete"]>[0];
    options?: Parameters<ModelRuntime["complete"]>[1];
  }> = [];

  await assert.rejects(
    classifyAndRoute({
      config,
      messages,
      judgeRuntime: runtimeWithComplete((_request, options) => pendingUntilAbort(options?.signal), calls),
      abortSignal: abortController.signal,
    }),
    /turn cancelled/,
  );
  assert.equal(calls.length, 1);
});

test("provider 错误不可重试时落 fallback，失败消息脱敏且不含凭证明文", async () => {
  const calls: Array<{
    request: Parameters<ModelRuntime["complete"]>[0];
    options?: Parameters<ModelRuntime["complete"]>[1];
  }> = [];
  const decision = await classifyAndRoute({
    config,
    messages,
    judgeRuntime: runtimeWithComplete(() => {
      throw new ModelProviderError({
        provider: "judge",
        protocol: "openai",
        code: "auth_error",
        message: "authorization: bearer sk-secret-abc123 (api_key=xyz) 401",
        retryable: false,
      });
    }, calls),
  });

  assert.equal(decision?.resolvedFrom, "fallback");
  assert.equal(decision?.failureReason, "model_error");
  assert.equal(decision?.failure?.reason, "model_error");
  assert.equal(decision?.failure?.attempts, 1);
  assert.equal(decision?.failure?.code, "auth_error");
  assert.ok(decision?.failure?.message);
  assert.match(decision!.failure!.message!, /<redacted>/);
  assert.doesNotMatch(decision!.failure!.message!, /sk-secret-abc123/);
  assert.doesNotMatch(decision!.failure!.message!, /xyz/);
  assert.equal(calls.length, 1);
});

test("ModelRequestError 不重试，直接落 fallback", async () => {
  const calls: Array<{
    request: Parameters<ModelRuntime["complete"]>[0];
    options?: Parameters<ModelRuntime["complete"]>[1];
  }> = [];
  const decision = await classifyAndRoute({
    config,
    messages,
    judgeRuntime: runtimeWithComplete(() => {
      throw new ModelRequestError("invalid_request", "request rejected");
    }, calls),
  });

  assert.equal(decision?.resolvedFrom, "fallback");
  assert.equal(decision?.failureReason, "model_error");
  assert.equal(decision?.failure?.attempts, 1);
  assert.equal(calls.length, 1);
});

test("provider 错误可重试时重试后成功，命中 judge 分级", async () => {
  const calls: Array<{
    request: Parameters<ModelRuntime["complete"]>[0];
    options?: Parameters<ModelRuntime["complete"]>[1];
  }> = [];
  let callCount = 0;
  const decision = await classifyAndRoute({
    config,
    messages,
    judgeRuntime: runtimeWithComplete(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new ModelProviderError({
          provider: "judge",
          protocol: "openai",
          code: "server_error",
          message: "upstream 503",
          retryable: true,
        });
      }
      return Promise.resolve(tierResponse("simple"));
    }, calls),
  });

  assert.equal(decision?.resolvedFrom, "judge");
  assert.equal(decision?.tier, "simple");
  assert.equal(calls.length, 2);
});
