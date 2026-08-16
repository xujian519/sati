import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import {
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
  } as never;
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
