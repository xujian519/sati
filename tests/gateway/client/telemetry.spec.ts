import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import {
  createSubmitFailedFailure,
  createTurnTimeoutFailure,
  emitSessionTelemetry,
  inferToolErrorCategory,
  resolveSubmitTurnTelemetry,
} from "../../../src/gateway/client/telemetry.js";

test("telemetry: resolveSubmitTurnTelemetry 缺省 session/user_session", () => {
  const out = resolveSubmitTurnTelemetry({ sessionKey: "s1", message: "hi", channelKey: "web" });
  assert.equal(out.ownerModule, "session");
  assert.equal(out.executionKind, "user_session");
});

test("telemetry: resolveSubmitTurnTelemetry always-on 前缀映射", () => {
  const out = resolveSubmitTurnTelemetry({
    sessionKey: "s1",
    message: "hi",
    channelKey: "always-on/discovery",
  });
  assert.equal(out.ownerModule, "always_on");
  assert.equal(out.executionKind, "always_on");
  assert.equal(out.phase, "discovery");
});

test("telemetry: emitSessionTelemetry 无 telemetry 客户端直接返回", () => {
  emitSessionTelemetry(undefined, { type: "model_event" } as unknown as AgentEvent, {
    sessionId: "s1",
    runId: "r1",
    channelKey: "web",
    permissionMode: "default",
    ownerModule: "session",
    executionKind: "user_session",
  });
});

test("telemetry: model_event request_started 触发 trackFeatureLoopStage", () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeTelemetry = {
    trackFeatureLoopStage: (input: Record<string, unknown>) => calls.push(input),
    trackError: () => {},
  } as unknown as Parameters<typeof emitSessionTelemetry>[0];
  emitSessionTelemetry(
    fakeTelemetry,
    {
      type: "model_event",
      sessionId: "s1",
      turnId: "t1",
      event: { type: "request_started", provider: "anthropic", model: "claude-x" },
    } as unknown as AgentEvent,
    {
      sessionId: "s1",
      runId: "r1",
      channelKey: "web",
      permissionMode: "default",
      ownerModule: "session",
      executionKind: "user_session",
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.loopStage, "model_request");
  assert.equal(calls[0]!.outcome, "success");
  assert.deepEqual((calls[0]!.metadata as { provider: string }).provider, "anthropic");
});

test("telemetry: inferToolErrorCategory 分类", () => {
  assert.equal(inferToolErrorCategory("invalid_argument"), "tool_param_error");
  assert.equal(inferToolErrorCategory("parse_error"), "tool_result_parse_error");
  assert.equal(inferToolErrorCategory("boom"), "tool_runtime_error");
  assert.equal(inferToolErrorCategory(undefined), "tool_runtime_error");
});

test("telemetry: createTurnTimeoutFailure —— 落盘 status 与流内事件同源同文案", () => {
  const { status, event } = createTurnTimeoutFailure({
    runId: "r1",
    message: "Turn exceeded the 50ms timeout.",
    timeoutMs: 50,
  });
  assert.equal(event.code, "turn_timeout");
  assert.equal(event.runId, "r1");
  assert.equal(event.recoverable, false);
  assert.equal(event.message, "Turn exceeded the 50ms timeout.");
  // status 侧：event 名与 text 必须与事件体一致（改一边漏一边不会红 —— 本用例就是那条判据）。
  assert.equal(status.event, "turn_timeout");
  assert.equal(status.kind, "error");
  assert.equal(status.text, event.message, "落盘文本与流内 message 必须同文案");
  const detail = status.detail;
  assert.ok(detail, "失败 status 必须带 detail");
  assert.equal(detail["userHint"], event.userHint, "userHint 不得两处漂移");
  assert.equal(detail["scope"], "turn");
  assert.equal(detail["timeoutMs"], 50, "timeoutMs 只进落盘 status detail");
});

test("telemetry: createSubmitFailedFailure —— code 对齐且不携带落盘 detail", () => {
  const { status, event } = createSubmitFailedFailure({ runId: "r2", message: "boom" });
  assert.equal(event.code, "gateway_submit_failed");
  assert.equal(event.recoverable, false);
  assert.equal(status.event, "gateway_submit_failed");
  assert.equal(status.text, "boom");
  const detail = status.detail;
  assert.ok(detail, "失败 status 必须带 detail");
  assert.equal(detail["userHint"], event.userHint);
  assert.equal(detail["timeoutMs"], undefined, "非超时失败不得带 timeoutMs");
});
