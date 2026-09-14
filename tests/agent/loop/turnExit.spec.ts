import assert from "node:assert/strict";
import test from "node:test";
import { TokenCapManager } from "../../../src/agent/loop/tokenCapManager.js";
import { TurnRuntimeState } from "../../../src/agent/loop/turnRuntimeState.js";
import {
  abortTurn,
  buildTurnResult,
  captureAbortedPartial,
  captureTurn,
  createAbortStatus,
  emitStatus,
  terminateTurn,
  type TurnExitDeps,
} from "../../../src/agent/loop/turnExit.js";
import { agentError } from "../../../src/agent/protocol/errors.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import type { AgentStatusMessage } from "../../../src/agent/loop/modelErrors.js";
import { applyModelEventToAssembler, createModelMessageAssemblerState } from "../../../src/model/index.js";

/**
 * turn 出口与中止捕获模块行为基线（AgentLoop 拆解；issue #147）。
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

function makeDeps(contextRuntime?: TurnExitDeps["contextRuntime"], nowIso = "2026-09-14T01:02:03.004Z"): TurnExitDeps {
  return {
    tokenCaps: new TokenCapManager({ provider: "p1", model: "m1" }, {}),
    contextRuntime,
    now: () => new Date(nowIso),
  };
}

function errorResult(): AgentTurnResult {
  return {
    type: "error",
    sessionId: "s1",
    turnId: "t1",
    stopReason: "model_error",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: STARTED_AT,
    completedAt: STARTED_AT,
    errors: [agentError("agent_model_error", "boom")],
  };
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

test("buildTurnResult：sessionId/turnId/completedAt 由入参与 now 补齐", () => {
  const result = buildTurnResult(
    baseInput(),
    { type: "success", stopReason: "completed", usage: {}, permissionDenials: [], turns: 2, startedAt: STARTED_AT },
    new Date("2026-09-14T01:02:03.004Z"),
  );
  assert.equal(result.sessionId, "s1");
  assert.equal(result.turnId, "t1");
  assert.equal(result.completedAt, "2026-09-14T01:02:03.004Z");
  assert.equal(result.type, "success");
  assert.equal(result.turns, 2);
});

test("emitStatus：转发状态消息并返回 agent_status 事件（无回调时仍返回事件）", async () => {
  const seen: AgentStatusMessage[] = [];
  const status: AgentStatusMessage = { event: "turn_aborted", kind: "status", text: "aborted", detail: { a: 1 } };
  const input = baseInput({ onAgentStatusMessage: async message => void seen.push(message) });

  const event = await emitStatus(input, status);
  assert.deepEqual(seen, [status]);
  assert.equal(event.type, "agent_status");
  if (event.type !== "agent_status") return;
  assert.equal(event.sessionId, "s1");
  assert.equal(event.turnId, "t1");
  assert.equal(event.event, "turn_aborted");
  assert.deepEqual(event.detail, { a: 1 });

  const noCallback = await emitStatus(baseInput(), status);
  assert.equal(noCallback.type, "agent_status");
});

test("createAbortStatus：仅超时/取消/中止类原因发射状态", () => {
  assert.equal(createAbortStatus(baseInput()), undefined, "无 abortSignal");
  assert.equal(
    createAbortStatus(baseInput({ abortSignal: AbortSignal.abort("switch session") })),
    undefined,
    "无关原因不发射",
  );

  const status = createAbortStatus(baseInput({ abortSignal: AbortSignal.abort("user cancelled") }));
  assert.equal(status?.event, "turn_aborted");
  assert.equal(status?.kind, "status");

  const errorReason = createAbortStatus(
    baseInput({ abortSignal: AbortSignal.abort(new Error("The operation was aborted due to timeout")) }),
  );
  assert.equal(errorReason?.event, "turn_aborted");
});

test("captureTurn：调用 context 钩子、透传 sessionId/turnId/messages/errored", async () => {
  const calls: Array<{ sessionId: string; turnId: string; messages: unknown[]; errored: boolean }> = [];
  const contextRuntime = {
    captureTurn: async (arg: { sessionId: string; turnId: string; messages: unknown[]; errored: boolean }) => {
      calls.push(arg);
    },
  } as unknown as TurnExitDeps["contextRuntime"];
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  await captureTurn(makeDeps(contextRuntime), input, state, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionId, "s1");
  assert.equal(calls[0]!.turnId, "t1");
  assert.equal(calls[0]!.errored, true);
  assert.deepEqual(calls[0]!.messages, state.messages);
});

test("captureTurn：无钩子为空操作，钩子抛错被吞掉", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  await captureTurn(makeDeps(), input, state, false);

  const throwing = {
    captureTurn: async () => {
      throw new Error("hook boom");
    },
  } as unknown as TurnExitDeps["contextRuntime"];
  await captureTurn(makeDeps(throwing), input, state, false);
});

test("terminateTurn：turn_failed（可选）→ turn_completed → 透传 return", async () => {
  const contextRuntime = {
    captureTurn: async () => undefined,
  } as unknown as TurnExitDeps["contextRuntime"];
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  const result = errorResult();

  const { events, value } = await drain(
    terminateTurn(makeDeps(contextRuntime), input, state, result, { emitFailureEvent: true }),
  );
  assert.deepEqual(
    events.map(event => event.type),
    ["turn_failed", "turn_completed"],
  );
  assert.equal(value.kind, "return");
  assert.equal(value.result, result);
  assert.deepEqual(value.messages, state.messages);

  const quiet = await drain(terminateTurn(makeDeps(), input, state, result));
  assert.deepEqual(
    quiet.events.map(event => event.type),
    ["turn_completed"],
    "未开 emitFailureEvent 不发 turn_failed",
  );
});

test("terminateTurn：errored 取显式值，否则按 result.type 推导", async () => {
  const seen: boolean[] = [];
  const contextRuntime = {
    captureTurn: async (arg: { errored: boolean }) => void seen.push(arg.errored),
  } as unknown as TurnExitDeps["contextRuntime"];
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  await drain(terminateTurn(makeDeps(contextRuntime), input, state, { ...errorResult(), type: "success" }));
  await drain(terminateTurn(makeDeps(contextRuntime), input, state, errorResult()));
  await drain(terminateTurn(makeDeps(contextRuntime), input, state, errorResult(), { errored: false }));

  assert.deepEqual(seen, [false, true, false]);
});

test("captureAbortedPartial：落库安全部分文本并触发 onDurableMessage", async () => {
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, { type: "text_delta", text: "partial answer" });

  const durable: unknown[] = [];
  const input = baseInput({ onDurableMessage: async message => void durable.push(message) });
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  const { events } = await drain(captureAbortedPartial(state, input, assembler));
  assert.deepEqual(
    events.map(event => event.type),
    ["assistant_message"],
  );
  assert.equal(state.messages.length, 2);
  assert.ok(state.finalMessage);
  assert.equal(durable.length, 1);
});

test("captureAbortedPartial：含工具片段时不落库（safeFinalTextMessage 过滤）", async () => {
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, { type: "text_delta", text: "let me write" });
  applyModelEventToAssembler(assembler, {
    type: "tool_call_end",
    toolCall: { id: "c1", name: "write_file", input: { path: "a.ts" } },
  });

  const durable: unknown[] = [];
  const input = baseInput({ onDurableMessage: async message => void durable.push(message) });
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  const { events } = await drain(captureAbortedPartial(state, input, assembler));
  assert.deepEqual(events, []);
  assert.equal(state.messages.length, 1);
  assert.equal(state.finalMessage, undefined);
  assert.equal(durable.length, 0);
});

test("abortTurn：可中止状态下发射 abort 状态再收尾", async () => {
  const input = baseInput({ abortSignal: AbortSignal.abort("user cancelled") });
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  const { events, value } = await drain(abortTurn(makeDeps(), input, state));
  assert.deepEqual(
    events.map(event => event.type),
    ["agent_status", "turn_completed"],
  );
  assert.equal(value.kind, "return");
  assert.equal(value.result.type, "aborted");
  assert.equal(value.result.stopReason, "aborted_streaming");
  assert.equal(value.result.completedAt, "2026-09-14T01:02:03.004Z");
});

test("abortTurn：不可展示原因时只发 turn_completed", async () => {
  const input = baseInput();
  const state = new TurnRuntimeState(input, {}, STARTED_AT);

  const { events, value } = await drain(abortTurn(makeDeps(), input, state));
  assert.deepEqual(
    events.map(event => event.type),
    ["turn_completed"],
  );
  assert.equal(value.result.type, "aborted");
});
