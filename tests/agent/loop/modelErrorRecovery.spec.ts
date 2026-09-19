import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContextRuntime } from "../../../src/context/ContextRuntime.js";
import type { AutoCompactResult } from "../../../src/context/index.js";
import {
  learnOutputCapFromRejection,
  projectMissingToolResults,
  recoverFromJsonSelfCorrect,
  recoverFromMaxOutputLimit,
  recoverFromModelError,
  recoverFromReactiveDecision,
  recoverFromStreamInterruption,
  retryMissingReasoningContent,
  surfaceModelError,
  type ModelErrorRecoveryDeps,
} from "../../../src/agent/loop/modelErrorRecovery.js";
import { TokenCapManager } from "../../../src/agent/loop/tokenCapManager.js";
import {
  MAX_JSON_SELF_CORRECT_RETRIES,
  MAX_OUTPUT_RECOVERY_LIMIT,
  MAX_STREAM_INTERRUPTION_RECOVERIES,
  TurnRuntimeState,
} from "../../../src/agent/loop/turnRuntimeState.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import type {
  AssembledAssistantMessage,
  CanonicalMessage,
  CanonicalModelError,
  CanonicalModelRequest,
} from "../../../src/model/index.js";
import type { RouterDecision } from "../../../src/router/index.js";

/**
 * 模型错误恢复链行为基线（AgentLoop 拆解；issue #147 / TD-AGENT-101）。
 *
 * 覆盖：各条互斥恢复路径的触发条件与产物、调度顺序（reactive 探针必须在
 * 补齐工具结果之后）、以及全链 unhandled 时的兜底错误面。
 */

const STARTED_AT = "2026-09-14T00:00:00.000Z";
const DECISION: RouterDecision = { provider: "p1", model: "m1" } as RouterDecision;
const REQUEST: CanonicalModelRequest = {
  provider: "p1",
  model: "m1",
  messages: [],
  stream: true,
  maxOutputTokens: 32768,
};

function error(overrides: Partial<CanonicalModelError>): CanonicalModelError {
  return {
    provider: "p1",
    protocol: "openai",
    code: "invalid_request",
    status: 400,
    message: "",
    retryable: false,
    ...overrides,
  };
}

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assembled(overrides: Partial<AssembledAssistantMessage> = {}): AssembledAssistantMessage {
  return {
    message: assistant("partial output"),
    finishReason: "stop",
    hasMessageEnd: false,
    toolCalls: [],
    ...overrides,
  };
}

interface Harness {
  input: AgentLoopInput;
  state: TurnRuntimeState;
  deps: ModelErrorRecoveryDeps;
  tokenCaps: TokenCapManager;
  durable: CanonicalMessage[];
  lifecycle: string[];
  autoCompactCalls: Array<Record<string, unknown>>;
  /** 窗口观测回写（#449）的调用记录。 */
  observedWindows: Array<{ provider: string; model: string; maxContextTokens: number; reason: string }>;
}

interface HarnessOptions {
  messages?: CanonicalMessage[];
  jsonSelfCorrect?: boolean;
  contextRuntime?: AgentContextRuntime;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const messages = options.messages ?? [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  const durable: CanonicalMessage[] = [];
  const lifecycle: string[] = [];
  const autoCompactCalls: Array<Record<string, unknown>> = [];
  const observedWindows: Array<{ provider: string; model: string; maxContextTokens: number; reason: string }> = [];
  const input: AgentLoopInput = {
    sessionId: "s1",
    turnId: "t1",
    messages,
    onDurableMessage: message => {
      durable.push(message);
    },
  };
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  const tokenCaps = new TokenCapManager({ provider: "p1", model: "m1", maxOutputTokens: 32768 }, {});
  const deps: ModelErrorRecoveryDeps = {
    tokenCaps,
    contextRuntime: options.contextRuntime,
    now: () => new Date("2026-09-14T01:02:03.004Z"),
    jsonSelfCorrect: options.jsonSelfCorrect,
    missingToolResultRecoveryContext: () => ({ cwd: "/tmp/ws", permissionMode: "default" }),
    dispatchLifecycle: async (_input, event) => {
      lifecycle.push(event);
      return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
    },
    runAutoCompact: async function* (_state, _input, autoCompactOptions) {
      autoCompactCalls.push(autoCompactOptions as unknown as Record<string, unknown>);
      yield* [] as AgentEvent[];
      return { compacted: false };
    },
    recordObservedContextWindow: input => {
      observedWindows.push(input);
    },
  };
  return { input, state, deps, tokenCaps, durable, lifecycle, autoCompactCalls, observedWindows };
}

function contextRuntime(overrides: {
  recoverFromModelError?: AgentContextRuntime["recoverFromModelError"];
  tryAutoCompact?: AgentContextRuntime["tryAutoCompact"];
}): AgentContextRuntime {
  return overrides as unknown as AgentContextRuntime;
}

async function drain<T>(
  generator: AsyncGenerator<AgentEvent, T, unknown>,
): Promise<{ events: AgentEvent[]; value: T }> {
  const events: AgentEvent[] = [];
  while (true) {
    const step = await generator.next();
    if (step.done) return { events, value: step.value };
    events.push(step.value);
  }
}

const eventTypes = (events: AgentEvent[]): string[] => events.map(event => event.type);

// ---------------------------------------------------------------------------
// 单条恢复路径
// ---------------------------------------------------------------------------

test("learnOutputCapFromRejection：400 指名上限时学到天花板并隐形重试", async () => {
  const h = makeHarness();
  const err = error({
    message: "Invalid parameter: max_tokens 32768 > 8192, which is the maximum allowed.",
  });

  const { events, value } = await drain(
    learnOutputCapFromRejection(h.deps, h.state, h.input, REQUEST, DECISION, err, 32768),
  );

  assert.equal(h.state.hasAttemptedOutputCapRetry, true);
  assert.equal(h.tokenCaps.currentMaxOutputTokens("p1", "m1"), 8192);
  assert.deepEqual(eventTypes(events), ["warning", "turn_continued"]);
  assert.deepEqual(value, { kind: "continue" });
});

test("learnOutputCapFromRejection：已学过上限时不再接管（单发守卫）", async () => {
  const h = makeHarness();
  h.state.hasAttemptedOutputCapRetry = true;
  const err = error({ message: "max_tokens 32768 > 8192, which is the maximum allowed." });

  const { events, value } = await drain(
    learnOutputCapFromRejection(h.deps, h.state, h.input, REQUEST, DECISION, err, 32768),
  );

  assert.deepEqual(events, []);
  assert.deepEqual(value, { kind: "unhandled" });
  assert.equal(h.tokenCaps.currentMaxOutputTokens("p1", "m1"), 32768);
});

test("recoverFromStreamInterruption：text 阶段中断保留可见文本并续接", async () => {
  const h = makeHarness();
  const err = error({ code: "timeout", streamInterruption: { phase: "text" }, retryable: true });

  const { events, value } = await drain(recoverFromStreamInterruption(h.deps, h.state, h.input, err, assembled(), []));

  assert.deepEqual(eventTypes(events), ["assistant_message", "turn_continued"]);
  assert.equal(h.state.streamInterruptionRecoveryCount, 1);
  assert.deepEqual(h.state.finalMessage, assistant("partial output"));
  assert.equal(h.durable.length, 1);
  assert.equal(h.state.activeTransientPromptIds.size, 1);
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromStreamInterruption：带工具片段时绝不落库半截内容", async () => {
  const h = makeHarness();
  const err = error({ code: "timeout", streamInterruption: { phase: "tool_call" }, retryable: true });
  const toolCalls = [{ id: "c1", name: "write_file", input: { path: "a.mjs" } }];

  const { events, value } = await drain(
    recoverFromStreamInterruption(h.deps, h.state, h.input, err, assembled(), toolCalls),
  );

  assert.deepEqual(eventTypes(events), ["turn_continued"]);
  assert.equal(h.state.finalMessage, undefined);
  assert.equal(h.durable.length, 0);
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromStreamInterruption：次数耗尽后走错误面（含 StopFailure 生命周期）", async () => {
  const h = makeHarness();
  h.state.streamInterruptionRecoveryCount = MAX_STREAM_INTERRUPTION_RECOVERIES;
  const err = error({ code: "timeout", streamInterruption: { phase: "text" }, retryable: true });

  const { events, value } = await drain(recoverFromStreamInterruption(h.deps, h.state, h.input, err, assembled(), []));

  assert.deepEqual(eventTypes(events), [
    "assistant_message",
    "stop_failure",
    "agent_status",
    "turn_failed",
    "turn_completed",
  ]);
  assert.deepEqual(h.lifecycle, ["StopFailure"]);
  assert.equal(value.kind, "return");
  assert.equal(value.kind === "return" ? value.result.type : undefined, "error");
});

test("recoverFromStreamInterruption：非中断错误不接管", async () => {
  const h = makeHarness();
  const { events, value } = await drain(
    recoverFromStreamInterruption(h.deps, h.state, h.input, error({}), assembled(), []),
  );

  assert.deepEqual(events, []);
  assert.deepEqual(value, { kind: "unhandled" });
});

test("retryMissingReasoningContent：缺推理内容时插标记并单次重试", async () => {
  const h = makeHarness();
  const err = error({
    code: "invalid_request",
    status: 400,
    message:
      "Assistant messages in thinking mode must be passed back with their reasoning_content. Please check the request.",
  });

  const first = await drain(retryMissingReasoningContent(h.state, h.input, err));
  assert.equal(h.state.hasAttemptedReasoningContentRetry, true);
  assert.deepEqual(eventTypes(first.events), ["turn_continued"]);
  assert.deepEqual(first.value, { kind: "continue" });

  const second = await drain(retryMissingReasoningContent(h.state, h.input, err));
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.value, { kind: "unhandled" });
});

test("projectMissingToolResults：无工具调用时零开销", async () => {
  const h = makeHarness();
  const before = [...h.state.messages];

  const { events } = await drain(projectMissingToolResults(h.deps, h.state, h.input, []));

  assert.deepEqual(events, []);
  assert.deepEqual(h.state.messages, before);
  assert.equal(h.durable.length, 0);
});

test("projectMissingToolResults：为未执行工具调用补齐结果块并落库", async () => {
  const h = makeHarness();
  const toolCalls = [{ id: "c1", name: "write_file", input: { path: "a.mjs" } }];

  const { events } = await drain(projectMissingToolResults(h.deps, h.state, h.input, toolCalls));

  assert.deepEqual(eventTypes(events), ["tool_results_projected"]);
  const projected = h.state.messages.at(-1);
  assert.equal(projected?.role, "user");
  assert.deepEqual(
    projected?.content.map(block => block.type),
    ["tool_result"],
  );
  assert.equal(h.durable.length, 1);
});

test("recoverFromJsonSelfCorrect：开关开且参数非法 JSON 时自纠并计数", async () => {
  const h = makeHarness({ jsonSelfCorrect: true });
  const err = error({ code: "invalid_tool_arguments", message: "invalid json" });

  const { events, value } = await drain(recoverFromJsonSelfCorrect(h.deps, h.state, h.input, err));

  assert.equal(h.state.jsonSelfCorrectCount, 1);
  assert.deepEqual(eventTypes(events), ["turn_continued"]);
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromJsonSelfCorrect：开关关或超上限时不接管", async () => {
  const off = makeHarness({ jsonSelfCorrect: false });
  const err = error({ code: "invalid_tool_arguments" });
  assert.deepEqual((await drain(recoverFromJsonSelfCorrect(off.deps, off.state, off.input, err))).value, {
    kind: "unhandled",
  });

  const exhausted = makeHarness({ jsonSelfCorrect: true });
  exhausted.state.jsonSelfCorrectCount = MAX_JSON_SELF_CORRECT_RETRIES;
  assert.deepEqual(
    (await drain(recoverFromJsonSelfCorrect(exhausted.deps, exhausted.state, exhausted.input, err))).value,
    { kind: "unhandled" },
  );
});

test("recoverFromReactiveDecision：adjust_output_and_retry 调整输出上限并剥离错误对", async () => {
  const h = makeHarness({
    messages: [assistant("bad"), { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: [] }] }],
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({
        type: "adjust_output_and_retry",
        maxOutputTokens: 4096,
        reason: "prompt_too_long",
        scope: "hard_cap",
      }),
    }),
  });
  const err = error({ code: "max_tokens", message: "reduce max_tokens" });

  const { events, value } = await drain(recoverFromReactiveDecision(h.deps, h.state, h.input, DECISION, err));

  assert.equal(h.state.hasAttemptedOutputRetry, true);
  assert.equal(h.tokenCaps.currentMaxOutputTokens("p1", "m1"), 4096);
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(eventTypes(events), ["token_cap_adjusted", "turn_continued"]);
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromReactiveDecision：compact_and_retry 无压缩能力时按比例截头兜底", async () => {
  const h = makeHarness({
    messages: [assistant("bad"), { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: [] }] }],
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({ type: "compact_and_retry", reason: "prompt_too_long" }),
    }),
  });

  const { value } = await drain(
    recoverFromReactiveDecision(h.deps, h.state, h.input, DECISION, error({ code: "prompt_too_long" })),
  );

  assert.equal(h.state.hasAttemptedCompact, true);
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.autoCompactCalls, []);
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromReactiveDecision：compact_and_retry 走压缩执行器（窄接口参数）", async () => {
  const h = makeHarness({
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({
        type: "compact_and_retry",
        maxContextTokens: 200_000,
        maxOutputTokens: 8192,
        reason: "prompt_too_long",
      }),
      tryAutoCompact: async () => ({ type: "skipped", snapshot: {} }) as unknown as AutoCompactResult,
    }),
  });

  const { value } = await drain(
    recoverFromReactiveDecision(h.deps, h.state, h.input, DECISION, error({ code: "prompt_too_long" })),
  );

  assert.equal(h.state.hasAttemptedCompact, true);
  assert.deepEqual(h.autoCompactCalls, [
    {
      stage: "model-error-recovery",
      maxContextTokens: 200_000,
      reservedOutputTokens: 8192,
      emitAutoCompactEvent: false,
      fallbackTruncateRatio: 0.5,
    },
  ]);
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromReactiveDecision：strip_images_and_retry 剥离图片块", async () => {
  const h = makeHarness({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: "base64", data: "AAAA", mimeType: "image/png" },
        ],
      },
    ],
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({ type: "strip_images_and_retry", reason: "corrupt image" }),
    }),
  });

  const { value } = await drain(
    recoverFromReactiveDecision(h.deps, h.state, h.input, DECISION, error({ code: "invalid_image" })),
  );

  assert.deepEqual(
    h.state.messages[0]!.content.map(block => block.type),
    ["text", "text"],
  );
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromReactiveDecision：give_up / 探针抛错 / 未接线时不接管", async () => {
  const giveUp = makeHarness({
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({ type: "give_up", reason: "no idea" }),
    }),
  });
  assert.deepEqual(
    (await drain(recoverFromReactiveDecision(giveUp.deps, giveUp.state, giveUp.input, DECISION, error({})))).value,
    { kind: "unhandled" },
  );

  const throwing = makeHarness({
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => {
        throw new Error("probe exploded");
      },
    }),
  });
  assert.deepEqual(
    (await drain(recoverFromReactiveDecision(throwing.deps, throwing.state, throwing.input, DECISION, error({}))))
      .value,
    { kind: "unhandled" },
  );

  const unwired = makeHarness();
  assert.deepEqual(
    (await drain(recoverFromReactiveDecision(unwired.deps, unwired.state, unwired.input, DECISION, error({})))).value,
    { kind: "unhandled" },
  );
});

test("recoverFromMaxOutputLimit：触顶时交出恢复策略、耗尽时回 unhandled", async () => {
  const h = makeHarness();
  const err = error({ code: "max_output_reached", message: "output limit reached" });

  const bumped = await drain(recoverFromMaxOutputLimit(h.deps, h.state, h.input, DECISION, err, undefined));
  assert.deepEqual(bumped.value, { kind: "continue" });
  assert.equal(h.state.finalMessage, undefined);

  const exhausted = makeHarness();
  exhausted.state.hasAttemptedOutputRetry = true;
  exhausted.state.maxOutputRecoveryCount = MAX_OUTPUT_RECOVERY_LIMIT;
  assert.deepEqual(
    (await drain(recoverFromMaxOutputLimit(exhausted.deps, exhausted.state, exhausted.input, DECISION, err, undefined)))
      .value,
    { kind: "unhandled" },
  );

  const other = makeHarness();
  assert.deepEqual(
    (await drain(recoverFromMaxOutputLimit(other.deps, other.state, other.input, DECISION, error({}), undefined)))
      .value,
    { kind: "unhandled" },
  );
});

test("surfaceModelError：分类错误、广播 stop_failure 并以 error 结果收尾", async () => {
  const h = makeHarness();
  const err = error({ code: "invalid_api_key", message: "bad key" });

  const { events, value } = await drain(surfaceModelError(h.deps, h.state, h.input, err));

  assert.deepEqual(eventTypes(events), ["stop_failure", "agent_status", "turn_failed", "turn_completed"]);
  assert.deepEqual(h.lifecycle, ["StopFailure"]);
  assert.equal(value.kind, "return");
  assert.equal(value.kind === "return" ? value.result.type : undefined, "error");
  assert.deepEqual(value.kind === "return" ? value.result.errors?.map(e => [e.code, e.message]) : undefined, [
    ["agent_model_error", "bad key"],
  ]);
});

// ---------------------------------------------------------------------------
// 调度链
// ---------------------------------------------------------------------------

test("recoverFromModelError：无错误时直接回 continue", async () => {
  const h = makeHarness();

  const { events, value } = await drain(
    recoverFromModelError(h.deps, h.state, h.input, REQUEST, DECISION, assembled(), [], undefined),
  );

  assert.deepEqual(events, []);
  assert.deepEqual(value, { kind: "continue" });
});

test("recoverFromModelError：全部路径 unhandled 时落到错误面", async () => {
  const h = makeHarness({ jsonSelfCorrect: false });
  const err = error({ code: "server_error", status: 500, message: "boom", retryable: true });

  const { events, value } = await drain(
    recoverFromModelError(h.deps, h.state, h.input, REQUEST, DECISION, assembled({ error: err }), [], undefined),
  );

  assert.deepEqual(eventTypes(events), ["stop_failure", "agent_status", "turn_failed", "turn_completed"]);
  assert.equal(value.kind, "return");
});

test("recoverFromModelError：非中断错误会把流中断恢复计数清零", async () => {
  const h = makeHarness({ jsonSelfCorrect: false });
  h.state.streamInterruptionRecoveryCount = 1;

  await drain(
    recoverFromModelError(
      h.deps,
      h.state,
      h.input,
      REQUEST,
      DECISION,
      assembled({ error: error({ code: "server_error", status: 500, message: "boom" }) }),
      [],
      undefined,
    ),
  );

  assert.equal(h.state.streamInterruptionRecoveryCount, 0);
});

test("recoverFromModelError：reactive 探针在补齐工具结果之后被调用（顺序契约）", async () => {
  const seen: CanonicalMessage[][] = [];
  const h = makeHarness({
    contextRuntime: contextRuntime({
      recoverFromModelError: async input => {
        seen.push(input.messages);
        return { type: "give_up", reason: "no idea" };
      },
    }),
  });
  const toolCalls = [{ id: "c1", name: "write_file", input: { path: "a.mjs" } }];

  await drain(
    recoverFromModelError(
      h.deps,
      h.state,
      h.input,
      REQUEST,
      DECISION,
      assembled({ error: error({ code: "server_error", status: 500, message: "boom" }) }),
      toolCalls,
      undefined,
    ),
  );

  assert.equal(seen.length, 1);
  assert.equal(
    seen[0]!.some(message => message.content.some(block => block.type === "tool_result")),
    true,
  );
});

// ---------------------------------------------------------------------------
// 窗口观测回写（#449）：只信 provider-context-cap
// ---------------------------------------------------------------------------

test("recoverFromReactiveDecision：provider-context-cap 触发窗口持久回写", async () => {
  const h = makeHarness({
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({
        type: "compact_and_retry",
        maxContextTokens: 131072,
        reason: "provider-context-cap",
      }),
      tryAutoCompact: async () => ({ type: "skipped", snapshot: {} }) as unknown as AutoCompactResult,
    }),
  });

  await drain(recoverFromReactiveDecision(h.deps, h.state, h.input, DECISION, error({ code: "prompt_too_long" })));

  assert.deepEqual(h.observedWindows, [
    { provider: "p1", model: "m1", maxContextTokens: 131072, reason: "provider-context-cap" },
  ]);
});

test("recoverFromReactiveDecision：其余带 maxContextTokens 的 reason 不写回（数据形状≠语义）", async () => {
  const h = makeHarness({
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({
        type: "compact_and_retry",
        maxContextTokens: 200_000,
        reason: "prompt_too_long",
      }),
      tryAutoCompact: async () => ({ type: "skipped", snapshot: {} }) as unknown as AutoCompactResult,
    }),
  });

  await drain(recoverFromReactiveDecision(h.deps, h.state, h.input, DECISION, error({ code: "prompt_too_long" })));

  assert.deepEqual(h.observedWindows, []);
});

test("recoverFromReactiveDecision：截头兜底路径不写回", async () => {
  const h = makeHarness({
    contextRuntime: contextRuntime({
      recoverFromModelError: async () => ({ type: "truncate_head_and_retry", reason: "ptl-first-attempt" }),
    }),
  });

  await drain(recoverFromReactiveDecision(h.deps, h.state, h.input, DECISION, error({ code: "prompt_too_long" })));

  assert.deepEqual(h.observedWindows, []);
  // 负控制对照：同一条路径确实执行了（hasAttemptedCompact 被置位）。
  assert.equal(h.state.hasAttemptedCompact, true);
});
