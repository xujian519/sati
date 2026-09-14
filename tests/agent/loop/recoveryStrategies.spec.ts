import assert from "node:assert/strict";
import test from "node:test";
import { TokenCapManager } from "../../../src/agent/loop/tokenCapManager.js";
import {
  continueWithTransientPrompt,
  emitEmptyOutputTokenBump,
  recoverFromEmptyResponse,
  recoverFromMaxOutputBump,
} from "../../../src/agent/loop/recoveryStrategies.js";
import {
  MAX_CONSECUTIVE_EMPTY,
  MAX_OUTPUT_RECOVERY_LIMIT,
  TurnRuntimeState,
} from "../../../src/agent/loop/turnRuntimeState.js";
import type { TurnExitDeps } from "../../../src/agent/loop/turnExit.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import type { RouterDecision } from "../../../src/router/index.js";

/**
 * 共享恢复策略行为基线（AgentLoop 拆解；issue #147 / TD-AGENT-101）。
 */

const STARTED_AT = "2026-09-14T00:00:00.000Z";

function baseInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    sessionId: "s1",
    turnId: "t1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...overrides,
  };
}

function makeDeps(maxOutputTokens?: number): TurnExitDeps {
  return {
    tokenCaps: new TokenCapManager({ provider: "p1", model: "m1", maxOutputTokens }, {}),
    contextRuntime: undefined,
    now: () => new Date("2026-09-14T01:02:03.004Z"),
  };
}

const DECISION: RouterDecision = { provider: "p1", model: "m1" } as RouterDecision;
const REQUEST: CanonicalModelRequest = { provider: "p1", model: "m1", messages: [], stream: true };

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

test("continueWithTransientPrompt：注入 transient 提示并回 continue", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  const { events, value } = await drain(
    continueWithTransientPrompt(state, input, "pick up where you left off", "max_output_recovery"),
  );
  assert.equal(value.kind, "continue");
  assert.equal(events.length, 1);
  const event = events[0]!;
  if (event.type !== "turn_continued") return assert.fail("expected turn_continued");
  assert.equal(event.reason, "model_error");
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages.at(-1)!.metadata?.purpose, "max_output_recovery");
});

test("emitEmptyOutputTokenBump：非 length 结束时为空操作", async () => {
  const input = baseInput();
  const deps = makeDeps(4_096);

  const { events } = await drain(emitEmptyOutputTokenBump(deps, input, DECISION, "stop", undefined));
  assert.deepEqual(events, []);
  assert.equal(deps.tokenCaps.currentMaxOutputTokens("p1", "m1"), 4_096);
});

test("emitEmptyOutputTokenBump：length 结束时倍增并受路由上限压制", async () => {
  const input = baseInput();
  const deps = makeDeps(4_096);

  const { events } = await drain(emitEmptyOutputTokenBump(deps, input, DECISION, "length", undefined));
  assert.equal(events.length, 1);
  const event = events[0]!;
  if (event.type !== "empty_output_recovery") return assert.fail("expected empty_output_recovery");
  assert.equal(event.previousMaxOutputTokens, 4_096);
  assert.equal(event.nextMaxOutputTokens, 8_192);
  assert.equal(deps.tokenCaps.currentMaxOutputTokens("p1", "m1"), 8_192);

  const capped = makeDeps(4_096);
  const { events: cappedEvents } = await drain(
    emitEmptyOutputTokenBump(capped, input, DECISION, "length", /* routedMaxOutputTokens */ 6_000),
  );
  const cappedEvent = cappedEvents[0]!;
  if (cappedEvent.type !== "empty_output_recovery") return assert.fail("expected empty_output_recovery");
  assert.equal(cappedEvent.nextMaxOutputTokens, 6_000, "routed 上限压制倍增");
});

test("recoverFromMaxOutputBump：Phase A 提升一次（可剥离错误对）", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  state.messages.push(
    { role: "assistant", content: [{ type: "text", text: "cut" }] },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "c1", content: [{ type: "text", text: "x" }] }],
    },
  );
  const deps = makeDeps(4_096);

  const { events, value } = await drain(
    recoverFromMaxOutputBump(deps, state, input, DECISION, undefined, { stripTrailingErrorPairMessages: true }),
  );
  assert.equal(value, "bumped");
  assert.deepEqual(
    events.map(event => event.type),
    ["token_cap_adjusted", "turn_continued"],
  );
  assert.equal(state.hasAttemptedOutputRetry, true);
  assert.equal(deps.tokenCaps.currentMaxOutputTokens("p1", "m1"), 8_192);
  assert.equal(state.messages.length, 1, "错误对被剥离");
});

test("recoverFromMaxOutputBump：Phase A 不可用时走 Phase B 续跑", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  const deps = makeDeps(); // 无显式输出上限 → 无从倍增

  const { events, value } = await drain(recoverFromMaxOutputBump(deps, state, input, DECISION, undefined));
  assert.equal(value, "continuing");
  assert.deepEqual(
    events.map(event => event.type),
    ["turn_continued"],
  );
  assert.equal(state.maxOutputRecoveryCount, 1);
  assert.equal(state.messages.at(-1)!.metadata?.purpose, "max_output_recovery");
});

test("recoverFromMaxOutputBump：两条路都不可用时返回 exhausted 且不发事件", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  state.hasAttemptedOutputRetry = true;
  state.maxOutputRecoveryCount = MAX_OUTPUT_RECOVERY_LIMIT;

  const { events, value } = await drain(recoverFromMaxOutputBump(makeDeps(), state, input, DECISION, undefined));
  assert.equal(value, "exhausted");
  assert.deepEqual(events, []);
});

test("recoverFromEmptyResponse：首轮空响应注入提示并要求重试", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  state.maxOutputRecoveryCount = 1;

  const { events, value } = await drain(
    recoverFromEmptyResponse(makeDeps(), state, input, DECISION, REQUEST, undefined, undefined),
  );
  assert.equal(value, "recovered-return");
  assert.equal(state.consecutiveEmptyCount, 1);
  assert.equal(state.maxOutputRecoveryCount, 2);
  assert.deepEqual(
    events.map(event => event.type),
    ["turn_continued"],
  );
  assert.equal(state.messages.at(-1)!.metadata?.purpose, "max_output_recovery");
});

test("recoverFromEmptyResponse：连空预算耗尽时收尾为 success + errored", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  state.maxOutputRecoveryCount = 1;
  state.consecutiveEmptyCount = MAX_CONSECUTIVE_EMPTY - 1;
  state.messages.push({ role: "assistant", content: [{ type: "text", text: "thinking only" }] });

  const { events, value } = await drain(
    recoverFromEmptyResponse(makeDeps(), state, input, DECISION, REQUEST, undefined, undefined),
  );
  assert.deepEqual(
    events.map(event => event.type),
    ["agent_status", "turn_completed"],
  );
  assert.notEqual(typeof value, "string", "连空预算耗尽应返回 TurnStepReturn");
  if (typeof value === "string") return;
  assert.equal(value.kind, "return");
  assert.equal(value.result.type, "success");
  assert.equal(value.result.stopReason, "completed");
  assert.equal(value.result.finalMessage?.content[0]?.type, "text");
});

test("recoverFromEmptyResponse：首次空响应恢复一次，预算用尽后交给调用方", async () => {
  const input = baseInput();
  const first = new TurnRuntimeState(input, {}, STARTED_AT);
  const firstRun = await drain(
    recoverFromEmptyResponse(makeDeps(), first, input, DECISION, REQUEST, undefined, undefined),
  );
  assert.equal(firstRun.value, "recovered-return");
  assert.equal(first.hasAttemptedEmptyRetry, true);
  assert.equal(first.maxOutputRecoveryCount, 1);

  const second = new TurnRuntimeState(input, {}, STARTED_AT);
  second.hasAttemptedEmptyRetry = true;
  const secondRun = await drain(
    recoverFromEmptyResponse(makeDeps(), second, input, DECISION, REQUEST, undefined, undefined),
  );
  assert.equal(secondRun.value, "unhandled");
  assert.deepEqual(secondRun.events, []);
});
