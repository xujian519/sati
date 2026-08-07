import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelEvent, CanonicalUsage } from "../../../src/model/index.js";
import {
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "../../../src/router/retry/zeroUsageRetry.js";

function event(partial: Record<string, unknown>): CanonicalModelEvent {
  return partial as unknown as CanonicalModelEvent;
}

test("createZeroUsageState 初始全为 false", () => {
  assert.deepEqual(createZeroUsageState(), {
    observedAnyText: false,
    observedFinish: false,
    observedError: false,
  });
});

test("text_delta 非空文本置位 observedAnyText", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, event({ type: "text_delta", text: "hi" }));
  assert.equal(state.observedAnyText, true);
});

test("text_delta 空文本不置位", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, event({ type: "text_delta", text: "" }));
  assert.equal(state.observedAnyText, false);
});

test("tool_call_delta 非空与 tool_call_end 都置位 observedAnyText", () => {
  const a = createZeroUsageState();
  observeEventForZeroUsage(a, event({ type: "tool_call_delta", delta: "x" }));
  assert.equal(a.observedAnyText, true);

  const b = createZeroUsageState();
  observeEventForZeroUsage(b, event({ type: "tool_call_end" }));
  assert.equal(b.observedAnyText, true);
});

test("message_end 置位 observedFinish", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, event({ type: "message_end" }));
  assert.equal(state.observedFinish, true);
});

test("usage 事件记录 observedUsage", () => {
  const state = createZeroUsageState();
  const usage: CanonicalUsage = { totalTokens: 10 };
  observeEventForZeroUsage(state, event({ type: "usage", usage }));
  assert.equal(state.observedUsage, usage);
});

test("error 事件置位 observedError", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, event({ type: "error" }));
  assert.equal(state.observedError, true);
});

test("shouldRetryZeroUsage：observedError 时不重试", () => {
  const state = { ...createZeroUsageState(), observedError: true, observedFinish: true };
  assert.equal(shouldRetryZeroUsage(state), false);
});

test("shouldRetryZeroUsage：未结束时不重试", () => {
  const state = createZeroUsageState();
  assert.equal(shouldRetryZeroUsage(state), false);
});

test("shouldRetryZeroUsage：有文本输出时不重试", () => {
  const state = { ...createZeroUsageState(), observedAnyText: true, observedFinish: true };
  assert.equal(shouldRetryZeroUsage(state), false);
});

test("shouldRetryZeroUsage：结束且无 usage 时重试", () => {
  const state = { ...createZeroUsageState(), observedFinish: true };
  assert.equal(shouldRetryZeroUsage(state), true);
});

test("shouldRetryZeroUsage：usage 各字段全零时重试", () => {
  const usage: CanonicalUsage = { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
  const state = { ...createZeroUsageState(), observedFinish: true, observedUsage: usage };
  assert.equal(shouldRetryZeroUsage(state), true);
});

test("shouldRetryZeroUsage：usage 任一字段非零时不重试", () => {
  const usage: CanonicalUsage = { totalTokens: 0, outputTokens: 5 };
  const state = { ...createZeroUsageState(), observedFinish: true, observedUsage: usage };
  assert.equal(shouldRetryZeroUsage(state), false);
});
