import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { ModelProviderError } from "../../src/model/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { createRouterRuntime, type RouterEvent } from "../../src/router/index.js";

/**
 * 上游 #478（Sati 取「接线」部分）：token-saver 降级事件只记了 reason 与
 * fallbackTier，丢掉了「哪个 judge 模型失败、试了几次、错误码/错误信息」。
 *
 * 结果是线上只能看到「降级发生了」，无法区分是判官模型配错、被限流还是输出
 * 不可解析 —— 后两者的处置完全不同（换模型 vs 改提示词）。失败诊断本身已由
 * `classifyAndRoute` 产出（`TokenSaverFailure`，消息已脱敏），缺的只是把它接到
 * 事件上、并把决策输入的中止信号透传给判官请求。
 */

const request: CanonicalModelRequest = {
  provider: "local",
  model: "default",
  messages: [{ role: "user", content: [{ type: "text", text: "帮我分析这份权利要求" }] }],
  maxOutputTokens: 1024,
};

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "local/default", provider: "local", model: "default" } },
  tokenSaver: {
    enabled: true,
    judge: { id: "judge-provider/judge-model", provider: "judge-provider", model: "judge-model" },
    defaultTier: "simple",
    tiers: {
      simple: { model: { id: "local/simple", provider: "local", model: "simple" } },
      complex: { model: { id: "local/complex", provider: "local", model: "complex" } },
    },
    judgeTimeoutMs: 500,
  },
};

function runtimeWithComplete(complete: ModelRuntime["complete"]): ModelRuntime {
  return {
    complete,
    stream: () => {
      throw new Error("stream is not exercised in router runtime tests");
    },
    getCapabilities: () => ({ maxContextTokens: 0 }),
    getMultimodal: () => ({ images: false }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
}

/** 判官永不返回，只在请求被中止时拒绝（透传中止原因）。 */
function pendingUntilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    // 传入时已中止：中止事件早已派发，再挂监听不会触发，须直接判定。
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

function makeRuntime(modelRuntime: ModelRuntime, events: RouterEvent[]) {
  return createRouterRuntime(config, {
    modelRuntime,
    now: () => new Date(0),
    events: { emit: event => events.push(event) },
  });
}

test("判官失败降级时事件带出 judge 模型、重试次数与错误码", async () => {
  const events: RouterEvent[] = [];
  const runtime = makeRuntime(
    runtimeWithComplete(() => {
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "authorization: bearer sk-secret-abc123 rejected",
        retryable: false,
      });
    }),
    events,
  );

  await runtime.decide({ request, sessionId: "session-478", isMainAgent: true });

  const failed = events.find(event => event.type === "sati_router_token_saver_failed");
  assert.ok(failed, `expected a token-saver failure event, got ${JSON.stringify(events)}`);
  assert.equal(failed.reason, "model_error");
  assert.equal(failed.fallbackTier, "simple");
  assert.equal(failed.judgeProvider, "judge-provider");
  assert.equal(failed.judgeModel, "judge-model");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.errorCode, "auth_error");
  assert.ok(failed.errorMessage, "expected a sanitized provider message");
  assert.match(failed.errorMessage, /<redacted>/);
  assert.doesNotMatch(failed.errorMessage, /sk-secret-abc123/);
});

test("第三方网关回显的凭证形态被脱敏，不落盘到 router 事件", async () => {
  // 真实报错正文（OpenAI 兼容网关各家写法不同）：
  //   - "Incorrect API key provided: sk-proj-…"  —— 只裸报密钥，无 key= 上下文
  //   - "…?key=AIza…"                            —— 密钥进 URL 查询串
  //   - "401 Unauthorized: x-api-key sk-ant-…"   —— 密钥跟在头部名之后
  //   - 整个错误体被 JSON 序列化回显                 —— 键名/值各带一层引号
  // 旧实现只认 `bearer <tok>` 与 `key=value`，以上四种都会原样写进
  // `~/.sati/router/events.jsonl`（明文文件）。断言用「密钥本体」而非脱敏标记，
  // 避免只测到格式变化。
  const echoes: Array<{ label: string; message: string; secret: string }> = [
    {
      label: "裸报密钥",
      message: "Incorrect API key provided: sk-proj-Abcdefghijklmnopqrstuvwx. You can find your API key at ...",
      secret: "sk-proj-Abcdefghijklmnopqrstuvwx",
    },
    {
      label: "URL 查询串",
      message:
        "HTTP 400: https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyDabcdefghijklmnopqrst returned error",
      secret: "AIzaSyDabcdefghijklmnopqrst",
    },
    {
      label: "请求头名后接密钥",
      message: "401 Unauthorized: x-api-key sk-ant-Abcdefghijklmnopqrstuvwx is invalid",
      secret: "sk-ant-Abcdefghijklmnopqrstuvwx",
    },
    {
      label: "JSON 回显（有已知前缀）",
      message: '{"error":{"message":"bad key"},"api_key": "sk-live-Abcdefghijklmnopqrstuvwx"}',
      secret: "sk-live-Abcdefghijklmnopqrstuvwx",
    },
    {
      label: "JSON 回显（前缀未知的自建网关）",
      message: '{"api_key": "Qwerty1234567890Abcdef", "detail": "authentication failed"}',
      secret: "Qwerty1234567890Abcdef",
    },
  ];

  for (const { label, message, secret } of echoes) {
    const events: RouterEvent[] = [];
    const runtime = makeRuntime(
      runtimeWithComplete(() => {
        throw new ModelProviderError({
          provider: "judge-provider",
          protocol: "openai",
          code: "auth_error",
          message,
          retryable: false,
        });
      }),
      events,
    );

    await runtime.decide({ request, sessionId: `session-redact-${label}`, isMainAgent: true });

    const failed = events.find(event => event.type === "sati_router_token_saver_failed");
    assert.ok(failed?.errorMessage, `${label}: expected a sanitized provider message`);
    assert.doesNotMatch(failed.errorMessage, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), label);
    assert.match(failed.errorMessage, /redacted/i, label);
  }
});

test("判官超时降级时事件同样带出 judge 身份与诊断码", async () => {
  const events: RouterEvent[] = [];
  const runtime = makeRuntime(
    runtimeWithComplete((_request, options) => pendingUntilAbort(options?.signal)),
    events,
  );

  await runtime.decide({ request, sessionId: "session-478-timeout", isMainAgent: true });

  const failed = events.find(event => event.type === "sati_router_token_saver_failed");
  assert.ok(failed, `expected a token-saver failure event, got ${JSON.stringify(events)}`);
  assert.equal(failed.reason, "timeout");
  assert.equal(failed.judgeProvider, "judge-provider");
  assert.equal(failed.judgeModel, "judge-model");
  assert.equal(failed.errorCode, "judge_timeout");
});

test("决策输入的中止信号透传到判官请求：回合已取消时不再降级", async () => {
  const events: RouterEvent[] = [];
  const runtime = makeRuntime(
    runtimeWithComplete((_request, options) => pendingUntilAbort(options?.signal)),
    events,
  );
  const abortController = new AbortController();
  abortController.abort(new Error("turn cancelled"));

  await assert.rejects(
    runtime.decide({ request, sessionId: "session-478-abort", isMainAgent: true, abortSignal: abortController.signal }),
    /turn cancelled/,
  );
  assert.equal(
    events.filter(event => event.type === "sati_router_token_saver_failed").length,
    0,
    "已取消的回合不应记录降级事件",
  );
});
