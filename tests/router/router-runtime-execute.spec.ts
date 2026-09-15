import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
  MultimodalConstraints,
} from "../../src/model/index.js";
import type { RouterConfig, RouterModelRef } from "../../src/router/config/schema.js";
import { createRouterRuntime, type RouterEvent, type RouterStatsRecord } from "../../src/router/index.js";
import type { RouterDecision, RouterExecuteContext } from "../../src/router/index.js";

/**
 * `RouterRuntime.execute()` 执行/重试状态机的特征化（characterisation）测试。
 *
 * 债务 #343 / TD-ROUTER-002：`execute()` 是闭包内 411 行的异步生成器，
 * fallback / transient-retry / zero-usage 三套重试分支与「已产出内容是否可重放」
 * 咬合。改前 `tests/` 里 `sati_router_fallback` / `sati_router_zero_usage_retry` /
 * `sati_router_transient_retry` / `sati_router_execute_failed` **零命中** ——
 * 即这套状态机此前没有任何直接覆盖；全量套件里的 router 都是 `enabled: false`
 * 直通。这里逐条把既有语义钉死，作为抽取重构的行为锚。
 */

const PRIMARY: RouterModelRef = { id: "main/primary-model", provider: "main", model: "primary-model" };
const FALLBACK: RouterModelRef = { id: "main/fallback-model", provider: "main", model: "fallback-model" };

const TEXT_ONLY: MultimodalConstraints = { input: ["text"], images: false } as MultimodalConstraints;

const ctx: RouterExecuteContext = { sessionId: "session-exec", turnId: "turn-1" };

const request: CanonicalModelRequest = {
  provider: PRIMARY.provider,
  model: PRIMARY.model,
  maxOutputTokens: 1_024,
  messages: [{ role: "user", content: [{ type: "text", text: "帮我分析这份权利要求" }] }],
};

const SUCCESS_EVENTS: CanonicalModelEvent[] = [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text: "好的" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "message_end", finishReason: "stop" },
];

const RATE_LIMIT: CanonicalModelEvent = {
  type: "error",
  error: {
    provider: "main",
    protocol: "openai",
    code: "rate_limit_error",
    message: "429 too many requests",
    retryable: true,
  },
};

type Script = { events: CanonicalModelEvent[] } | { thrown: unknown };

function scripted(...events: CanonicalModelEvent[]): Script {
  return { events };
}

/** 按 `provider/model` 顺序消费脚本；同时记录每次 stream 的请求与顺序。 */
function makeStreamRuntime(
  scripts: Record<string, Script[]>,
  recorder: { calls: string[]; requests: CanonicalModelRequest[] },
): ModelRuntime {
  const queue = new Map(Object.entries(scripts).map(([key, value]) => [key, [...value]]));
  return {
    stream: (incoming: CanonicalModelRequest) => {
      const key = `${incoming.provider}/${incoming.model}`;
      recorder.calls.push(key);
      recorder.requests.push(incoming);
      const next = queue.get(key)?.shift();
      if (!next) {
        throw new Error(`no scripted stream left for ${key}`);
      }
      return (async function* () {
        if ("thrown" in next) {
          throw next.thrown;
        }
        for (const event of next.events) {
          yield event;
        }
      })();
    },
    complete: () => {
      throw new Error("complete is not exercised in execute tests");
    },
    getCapabilities: () => ({ maxContextTokens: 100_000, maxOutputTokens: 4_096 }),
    getMultimodal: () => TEXT_ONLY,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
}

function decisionFor(ref: RouterModelRef, overrides: Partial<RouterDecision> = {}): RouterDecision {
  return {
    provider: ref.provider,
    model: ref.model,
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
    ...overrides,
  };
}

type Harness = {
  runtime: ReturnType<typeof createRouterRuntime>;
  events: RouterEvent[];
  calls: string[];
  requests: CanonicalModelRequest[];
  stats: RouterStatsRecord[];
};

function harness(config: RouterConfig, scripts: Record<string, Script[]>): Harness {
  const events: RouterEvent[] = [];
  const recorder = { calls: [] as string[], requests: [] as CanonicalModelRequest[] };
  const runtime = createRouterRuntime(config, {
    modelRuntime: makeStreamRuntime(scripts, recorder),
    now: () => new Date(0),
    events: { emit: event => events.push(event) },
  });
  const stats: RouterStatsRecord[] = [];
  runtime.stats.observe = record => {
    stats.push(record);
  };
  return { runtime, events, stats, ...recorder };
}

async function collect(iterable: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const out: CanonicalModelEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
  }
  return out;
}

function closeBudget(config: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: PRIMARY },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    ...config,
  };
}

test("router 关闭时原样透传模型事件", async () => {
  const h = harness({ enabled: false }, { [PRIMARY.id]: [scripted(...SUCCESS_EVENTS)] });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.deepEqual(
    events.map(event => event.type),
    ["message_start", "text_delta", "usage", "message_end"],
  );
  assert.equal(h.calls.length, 1);
});

test("router 关闭时流抛错补一个 error 事件，网络错误被归类", async () => {
  const h = harness({ enabled: false }, { [PRIMARY.id]: [{ thrown: new Error("ECONNRESET: socket hang up") }] });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.equal(events.length, 1, `expected exactly one synthesized error, got ${JSON.stringify(events)}`);
  const [error] = events;
  assert.equal(error.type, "error");
  assert.ok(error.type === "error");
  assert.equal(error.error.code, "network_error");
  assert.equal(error.error.retryable, true);
  assert.equal(error.error.provider, "main");
});

test("成功路径：事件透传、统计落一条、不产生任何 router 事件", async () => {
  const h = harness(closeBudget(), { [PRIMARY.id]: [scripted(...SUCCESS_EVENTS)] });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.deepEqual(
    events.map(event => event.type),
    ["message_start", "text_delta", "usage", "message_end"],
  );
  assert.equal(h.events.length, 0, `expected no router events, got ${JSON.stringify(h.events)}`);
  assert.equal(h.stats.length, 1);
  assert.equal(h.stats[0].provider, "main");
  assert.equal(h.stats[0].model, "primary-model");
  assert.equal(h.stats[0].resolvedFrom, "scenario");
  assert.equal(h.stats[0].role, "main");
  assert.equal(h.stats[0].usage.totalTokens, 15);
  assert.equal(h.stats[0].startedAt, new Date(0).toISOString());
  assert.equal(h.stats[0].endedAt, new Date(0).toISOString());
});

test("首个 attempt 可重试错误且未产出内容时切到 fallback，错误事件不外泄", async () => {
  const h = harness(closeBudget({ fallback: { default: [FALLBACK] } }), {
    [PRIMARY.id]: [scripted(...[RATE_LIMIT])],
    [FALLBACK.id]: [scripted(...SUCCESS_EVENTS)],
  });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.deepEqual(h.calls, [PRIMARY.id, FALLBACK.id]);
  assert.deepEqual(
    events.map(event => event.type),
    ["message_start", "text_delta", "usage", "message_end"],
    "第一个 attempt 的错误事件应被吞掉，而不是泄漏给消费方",
  );

  const fallbackEvent = h.events.find(event => event.type === "sati_router_fallback");
  assert.ok(fallbackEvent, `expected a fallback event, got ${JSON.stringify(h.events)}`);
  assert.equal(fallbackEvent.attempt, 1);
  assert.equal(fallbackEvent.fromProvider, "main");
  assert.equal(fallbackEvent.fromModel, "primary-model");
  assert.equal(fallbackEvent.toProvider, "main");
  assert.equal(fallbackEvent.toModel, "fallback-model");
  assert.equal(fallbackEvent.error.code, "rate_limit_error");

  assert.equal(h.stats.length, 1);
  assert.equal(h.stats[0].model, "fallback-model");
  assert.equal(h.stats[0].resolvedFrom, "fallback");
});

test("已产出内容后不再 fallback，但会补出带 provider/model 的终态错误", async () => {
  const h = harness(closeBudget({ fallback: { default: [FALLBACK] } }), {
    [PRIMARY.id]: [
      scripted({ type: "message_start", role: "assistant" }, { type: "text_delta", text: "好的" }, RATE_LIMIT),
    ],
    [FALLBACK.id]: [scripted(...SUCCESS_EVENTS)],
  });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.deepEqual(h.calls, [PRIMARY.id], "已经吐出文本后不得回退（会产生重复文本）");
  assert.equal(h.events.filter(event => event.type === "sati_router_fallback").length, 0, "不得发出 fallback 事件");
  assert.deepEqual(
    events.map(event => event.type),
    ["message_start", "text_delta", "error", "error"],
    "流内错误照原样透传；收尾再补一个带 provider/model 的错误",
  );

  const executeFailed = h.events.find(event => event.type === "sati_router_execute_failed");
  assert.ok(executeFailed, `expected an execute-failed event, got ${JSON.stringify(h.events)}`);
  assert.equal(executeFailed.provider, "main");
  assert.equal(executeFailed.model, "primary-model");

  const final = events.at(-1);
  if (final?.type !== "error") {
    assert.fail(`expected the last event to be an error, got ${JSON.stringify(final)}`);
  }
  assert.equal(final.error.provider, "main");
  assert.equal(final.error.model, "primary-model");
  assert.equal(h.stats.length, 1, "失败也要落一条统计");
  assert.equal(h.stats[0].model, "primary-model");
  assert.ok((h.stats[0].usage.totalTokens ?? 0) > 0, "上游死在 usage 事件之前时，用量由 token 估算补齐（不是 0）");
});

test("无 fallback 候选时可重试错误走 transient retry 并在同一 attempt 内重试成功", async () => {
  const h = harness(closeBudget({ transientRetry: { enabled: true, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }), {
    [PRIMARY.id]: [scripted(RATE_LIMIT), scripted(...SUCCESS_EVENTS)],
  });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.deepEqual(h.calls, [PRIMARY.id, PRIMARY.id]);
  assert.deepEqual(
    events.map(event => event.type),
    ["message_start", "text_delta", "usage", "message_end"],
  );

  const transient = h.events.find(event => event.type === "sati_router_transient_retry");
  assert.ok(transient, `expected a transient-retry event, got ${JSON.stringify(h.events)}`);
  assert.equal(transient.attempt, 1);
  assert.equal(transient.errorCode, "rate_limit_error");
  assert.ok(transient.delayMs >= 0);

  const progress = h.events.find(event => event.type === "sati_router_retry_progress");
  assert.ok(progress, "重试应同时上报进度事件");
  assert.equal(progress.reason, "rate_limit");
  assert.equal(progress.maxAttempts, 2);
});

test("空回合（无内容、零用量）触发 zero-usage 重试", async () => {
  const h = harness(closeBudget({ zeroUsageRetry: { enabled: true, maxAttempts: 2 } }), {
    [PRIMARY.id]: [scripted({ type: "message_end", finishReason: "stop" }), scripted(...SUCCESS_EVENTS)],
  });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.deepEqual(h.calls, [PRIMARY.id, PRIMARY.id]);
  assert.deepEqual(
    events.map(event => event.type),
    ["message_start", "text_delta", "usage", "message_end"],
    "空回合的 message_end 不应泄漏给消费方",
  );

  const zeroUsage = h.events.find(event => event.type === "sati_router_zero_usage_retry");
  assert.ok(zeroUsage, `expected a zero-usage retry event, got ${JSON.stringify(h.events)}`);
  assert.equal(zeroUsage.attempt, 1);

  const progress = h.events.find(event => event.type === "sati_router_retry_progress");
  assert.ok(progress);
  assert.equal(progress.reason, "zero_usage");
});

test("所有 attempt 都失败时回放最后一个 attempt 的非错误缓冲事件", async () => {
  const failure: CanonicalModelEvent = {
    type: "error",
    error: {
      provider: "main",
      protocol: "openai",
      code: "billing",
      message: "insufficient quota",
      retryable: false,
    },
  };
  const h = harness(closeBudget({ fallback: { default: [FALLBACK] } }), {
    [PRIMARY.id]: [scripted({ type: "message_start", role: "assistant" }, failure)],
    [FALLBACK.id]: [scripted({ type: "message_start", role: "assistant" }, failure)],
  });

  const events = await collect(h.runtime.execute(decisionFor(PRIMARY), request, ctx));

  assert.deepEqual(h.calls, [PRIMARY.id, FALLBACK.id]);
  assert.equal(h.events.filter(event => event.type === "sati_router_fallback").length, 1);
  const executeFailed = h.events.find(event => event.type === "sati_router_execute_failed");
  assert.ok(executeFailed);
  assert.equal(executeFailed.provider, "main");
  assert.equal(executeFailed.model, "fallback-model");

  // 未产出过内容 ⇒ 回放最后一个 attempt 的缓冲事件（错误除外），再补终态错误。
  assert.deepEqual(
    events.map(event => event.type),
    ["message_start", "error", "message_start", "error"],
  );
  const last = events.at(-1);
  if (last?.type !== "error") {
    assert.fail(`expected the last event to be an error, got ${JSON.stringify(last)}`);
  }
  assert.equal(last.error.code, "billing");
});

test("模型不支持所需媒体时按降级请求重发，图片块被替换为占位文本", async () => {
  const h = harness(closeBudget(), { [PRIMARY.id]: [scripted(...SUCCESS_EVENTS)] });

  const events = await collect(
    h.runtime.execute(
      decisionFor(PRIMARY),
      {
        ...request,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "看看这张附图" },
              { type: "image", source: "base64", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          },
        ],
      },
      ctx,
    ),
  );

  assert.equal(events.length, 4);
  assert.equal(h.requests.length, 1);
  const sent = h.requests[0].messages[0].content;
  assert.ok(
    sent.every(block => block.type !== "image"),
    `expected the image block to be downgraded, got ${JSON.stringify(sent)}`,
  );
  assert.ok(
    sent.some(block => block.type === "text" && block.text.includes("看看这张附图")),
    "原文本块应保留",
  );
});

test("子代理超出 token 预算时不发请求，直接给出预算错误", async () => {
  const h = harness(
    closeBudget({
      autoOrchestrate: {
        enabled: true,
        triggerTiers: [],
        slimSystemPrompt: false,
        subagentMaxTokens: 1,
      },
    }),
    { [PRIMARY.id]: [scripted(...SUCCESS_EVENTS)] },
  );

  const events = await collect(
    h.runtime.execute(decisionFor(PRIMARY, { isSubagent: true, scenarioType: "subagent" }), request, ctx),
  );

  assert.equal(h.calls.length, 0, "预算超限不应发出模型请求");
  assert.equal(events.length, 1);
  const [only] = events;
  assert.ok(only.type === "error");
  assert.equal(only.error.code, "subagent_budget_exceeded");
  assert.equal(only.error.retryable, false);
  assert.ok(only.error.userHint, "预算错误应带可操作的提示");
  assert.equal(
    h.events.filter(event => event.type === "sati_router_execute_failed").length,
    0,
    "预算拦截不是执行失败，不应落 execute_failed 事件",
  );
});

test("回合已取消时不发起任何 attempt", async () => {
  const h = harness(closeBudget(), { [PRIMARY.id]: [scripted(...SUCCESS_EVENTS)] });
  const controller = new AbortController();
  controller.abort(new Error("turn cancelled"));

  const events = await collect(
    h.runtime.execute(decisionFor(PRIMARY), request, { ...ctx, abortSignal: controller.signal }),
  );

  assert.deepEqual(events, []);
  assert.equal(h.calls.length, 0);
  assert.equal(h.stats.length, 0);
});
