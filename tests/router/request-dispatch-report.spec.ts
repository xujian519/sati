import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
  MultimodalConstraints,
} from "../../src/model/index.js";
import type { RouterConfig, RouterModelRef } from "../../src/router/config/schema.js";
import {
  createRouterRuntime,
  type RouterDecision,
  type RouterDispatchReport,
  type RouterExecuteContext,
} from "../../src/router/index.js";

/**
 * 派发点报告（`RouterExecuteContext.onDispatchRequest`）的契约测试（issue #360）。
 *
 * 报告是「请求侧唯一验证手段」的事实源：它必须在**首字节之前**给出真正要上网的
 * 请求、该 attempt 的有效决策、以及本次派发**实际施行**的改写标签。落盘快照与
 * 报告两侧由不同入参派生，对拍（`verifyDispatchedRequest`）才有牙齿；因此这里逐条
 * 钉死「报告内容 == 实际 stream 的请求」以及「标签与施行事实一致」。
 */

const PRIMARY: RouterModelRef = { id: "main/primary-model", provider: "main", model: "primary-model" };
const FALLBACK: RouterModelRef = { id: "main/fallback-model", provider: "main", model: "fallback-model" };

const TEXT_ONLY = { input: ["text"], images: false } as MultimodalConstraints;

const SUCCESS_EVENTS: CanonicalModelEvent[] = [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text: "好的" },
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

const SUBAGENT_TAG = "<sati-subagent-model>main/fallback-model</sati-subagent-model>";

function requestWith(overrides: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest {
  return {
    provider: PRIMARY.provider,
    model: PRIMARY.model,
    maxOutputTokens: 1_024,
    messages: [{ role: "user", content: [{ type: "text", text: "帮我分析这份权利要求" }] }],
    ...overrides,
  };
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

function enabledConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: PRIMARY },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    ...overrides,
  };
}

type Harness = {
  runtime: ReturnType<typeof createRouterRuntime>;
  reports: RouterDispatchReport[];
  /** 每次 `modelRuntime.stream` 收到的请求，按调用顺序。 */
  streamed: CanonicalModelRequest[];
};

/** 脚本按 `provider/model` 顺序消费；默认每个 key 都能无限次成功。 */
function harness(config: RouterConfig, scripts: Record<string, CanonicalModelEvent[][]> = {}): Harness {
  const reports: RouterDispatchReport[] = [];
  const streamed: CanonicalModelRequest[] = [];
  const queue = new Map(Object.entries(scripts).map(([key, value]) => [key, [...value]]));
  const modelRuntime = {
    stream: (incoming: CanonicalModelRequest) => {
      streamed.push(incoming);
      const key = `${incoming.provider}/${incoming.model}`;
      const next = queue.get(key)?.shift() ?? SUCCESS_EVENTS;
      return (async function* () {
        for (const event of next) {
          yield event;
        }
      })();
    },
    complete: () => {
      throw new Error("complete 不在本 spec 覆盖范围");
    },
    getCapabilities: () => ({ maxContextTokens: 100_000, maxOutputTokens: 4_096 }),
    getMultimodal: () => TEXT_ONLY,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
  const runtime = createRouterRuntime(config, {
    modelRuntime,
    now: () => new Date(0),
    events: { emit: () => undefined },
  });
  return { runtime, reports, streamed };
}

function ctx(reports: RouterDispatchReport[]): RouterExecuteContext {
  return { sessionId: "session-dispatch", turnId: "turn-1", onDispatchRequest: report => reports.push(report) };
}

async function drain(iterable: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const out: CanonicalModelEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
  }
  return out;
}

test("直通路径（router 关闭）：报告的就是实际 stream 的请求，且不声明未施行的改写", async () => {
  const h = harness({ enabled: false });
  // requestPatch 在直通路径**未**被 applyDecisionToRequest 应用（该函数不在该分支上），
  // 故报告不得声明它——声明了就会把一条真实差异错误地放行。
  const decision = decisionFor(PRIMARY, { requestPatch: { messages: [] } });

  await drain(h.runtime.execute(decision, requestWith(), ctx(h.reports)));

  assert.equal(h.reports.length, 1);
  const [report] = h.reports;
  assert.ok(report);
  assert.equal(report.request, h.streamed[0], "报告里的请求必须就是交给 modelRuntime 的那个对象");
  assert.equal(report.decision, decision);
  assert.deepEqual(report.transforms, ["mediaDowngraded"], "直通路径无条件过一遍媒体降级，据此声明");
  assert.equal(report.request.provider, PRIMARY.provider);
});

test("输出上限被夹到模型能力上限时，报告值即夹取后的值且标签声明到位", async () => {
  const h = harness(enabledConfig());
  const request = requestWith({ maxOutputTokens: 10_000 });

  await drain(h.runtime.execute(decisionFor(PRIMARY), request, ctx(h.reports)));

  const [report] = h.reports;
  assert.ok(report);
  assert.equal(report.request.maxOutputTokens, 4_096, "报告须反映实际送出的上限（夹取后）");
  assert.deepEqual(report.transforms, ["maxOutputTokensClamped"]);
  assert.equal(h.streamed[0]?.maxOutputTokens, 4_096);
});

test("未触发夹取时不声明 maxOutputTokensClamped（标签取自施行事实，不是预设）", async () => {
  const h = harness(enabledConfig());

  await drain(h.runtime.execute(decisionFor(PRIMARY), requestWith({ maxOutputTokens: 512 }), ctx(h.reports)));

  assert.deepEqual(h.reports[0]?.transforms, []);
  assert.equal(h.reports[0]?.request.maxOutputTokens, 512);
});

test("subagentTagStripped：声明标签且报告请求里标记已剥离", async () => {
  const h = harness(enabledConfig());
  const request = requestWith({
    messages: [{ role: "user", content: [{ type: "text", text: `天真的请求 ${SUBAGENT_TAG}` }] }],
  });
  const decision = decisionFor(PRIMARY, { isSubagent: true, mutations: { subagentTagStripped: true } });

  await drain(h.runtime.execute(decision, request, ctx(h.reports)));

  const [report] = h.reports;
  assert.ok(report);
  assert.deepEqual(report.transforms, ["subagentTagStripped"]);
  const text = report.request.messages[0]?.content[0];
  assert.ok(text?.type === "text");
  assert.doesNotMatch(text.text, /sati-subagent-model/);
});

test("fallback attempt：决策指向 fallback 目标并声明 fallbackAttempt", async () => {
  const h = harness(enabledConfig({ fallback: { default: [FALLBACK] } }), {
    [PRIMARY.id]: [[RATE_LIMIT]],
    [FALLBACK.id]: [[...SUCCESS_EVENTS]],
  });

  await drain(h.runtime.execute(decisionFor(PRIMARY), requestWith(), ctx(h.reports)));

  assert.equal(h.reports.length, 2, "每个 attempt 各报一次");
  assert.deepEqual(h.reports[0]?.transforms, [], "首个 attempt 没有 fallback 相关改写");
  const second = h.reports[1];
  assert.ok(second);
  assert.deepEqual(second.transforms, ["fallbackAttempt"]);
  assert.equal(second.decision.model, FALLBACK.model, "报告里的决策即该 attempt 的有效决策");
  assert.equal(second.request.model, FALLBACK.model);
  assert.equal(second.request, h.streamed[1]);
});

test("同一 attempt 内的重试各自上报，且报告形态一致（报告点即派发点）", async () => {
  const h = harness(
    enabledConfig({ transientRetry: { enabled: true, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }),
    {
      [PRIMARY.id]: [[RATE_LIMIT], [...SUCCESS_EVENTS]],
    },
  );

  await drain(h.runtime.execute(decisionFor(PRIMARY), requestWith(), ctx(h.reports)));

  assert.equal(h.streamed.length, 2, "同一 attempt 内重试了两次");
  assert.equal(h.reports.length, 2, "每次实际派发各报一次（报告与流收口在同一条语句）");
  assert.deepEqual(h.reports[0], h.reports[1], "重试复用同一个请求对象，故两次报告一致");
});
