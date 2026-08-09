import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentStatusDetail,
  createAgentStatusHttpErrorBody,
  createVisibleErrorStatusDetail,
  isVisibleFailureStatusDetail,
  visibleStatusMessage,
} from "../../src/status/agentStatus.js";
import type { AgentStatusDetailInput, AgentStatusHttpErrorBody } from "../../src/status/agentStatus.js";

function baseDetailInput(overrides: Partial<AgentStatusDetailInput> = {}): AgentStatusDetailInput {
  return {
    message: "boom",
    scope: "turn",
    source: "agent",
    ...overrides,
  };
}

test("createAgentStatusDetail defaults visible to true", () => {
  const detail = createAgentStatusDetail(baseDetailInput());
  assert.equal(detail.visible, true);
});

test("createAgentStatusDetail prunes undefined fields", () => {
  const detail = createAgentStatusDetail(baseDetailInput());
  assert.equal("messageI18n" in detail, false);
  assert.equal("code" in detail, false);
  assert.equal("userHint" in detail, false);
  assert.equal("userHintI18n" in detail, false);
  assert.equal("severity" in detail, false);
  assert.equal("detail" in detail, false);
  assert.equal("scope" in detail, true);
  assert.equal("source" in detail, true);
});

test("createAgentStatusDetail preserves provided values and spreads detail", () => {
  const detail = createAgentStatusDetail(
    baseDetailInput({
      code: "E1",
      severity: "warning",
      visible: false,
      userHint: "fix it",
      detail: { status: 429, extra: "x" },
    }),
  );
  assert.equal(detail.message, "boom");
  assert.equal(detail.code, "E1");
  assert.equal(detail.severity, "warning");
  assert.equal(detail.visible, false);
  assert.equal(detail.userHint, "fix it");
  assert.equal(detail.status, 429);
  assert.equal(detail.extra, "x");
});

test("createVisibleErrorStatusDetail forces visible true and defaults severity to error", () => {
  const detail = createVisibleErrorStatusDetail({
    message: "boom",
    userHint: "fix it",
    scope: "http",
    source: "web_http",
  });
  assert.equal(detail.visible, true);
  assert.equal(detail.severity, "error");
});

test("createVisibleErrorStatusDetail keeps explicit warning severity", () => {
  const detail = createVisibleErrorStatusDetail({
    message: "careful",
    userHint: "watch out",
    severity: "warning",
    scope: "session",
    source: "gateway",
  });
  assert.equal(detail.severity, "warning");
  assert.equal(detail.visible, true);
});

test("createAgentStatusHttpErrorBody defaults code to event", () => {
  const body = createAgentStatusHttpErrorBody({
    event: "turn_failed",
    message: "boom",
    scope: "turn",
    source: "agent",
  });
  assert.equal(body.error.code, "turn_failed");
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.userHint, "Fix the request and retry.");
  assert.equal(body.agent_status.type, "agent_status");
  assert.equal(body.agent_status.event, "turn_failed");
  assert.equal(body.agent_status.detail.severity, "error");
  assert.equal(body.agent_status.detail.visible, true);
});

test("createAgentStatusHttpErrorBody omits status when undefined", () => {
  const body = createAgentStatusHttpErrorBody({
    event: "e",
    message: "m",
    scope: "turn",
    source: "agent",
  });
  assert.equal("status" in body.error, false);
  assert.equal("status" in body.agent_status.detail, false);
});

test("createAgentStatusHttpErrorBody maps 401/403 user hint", () => {
  for (const status of [401, 403]) {
    const body = createAgentStatusHttpErrorBody({
      event: "e",
      message: "m",
      status,
      scope: "http",
      source: "web_http",
    });
    assert.equal(body.error.userHint, "Check authentication and permissions, then retry.");
    assert.equal(body.error.status, status);
  }
});

test("createAgentStatusHttpErrorBody maps 429 user hint and type", () => {
  const body = createAgentStatusHttpErrorBody({
    event: "e",
    message: "m",
    status: 429,
    scope: "http",
    source: "web_http",
  });
  assert.equal(body.error.userHint, "Wait for the rate limit to reset, then retry.");
  assert.equal(body.error.type, "rate_limit_error");
});

test("createAgentStatusHttpErrorBody maps 413 user hint", () => {
  const body = createAgentStatusHttpErrorBody({
    event: "e",
    message: "m",
    status: 413,
    scope: "http",
    source: "web_http",
  });
  assert.equal(body.error.userHint, "Reduce the request size and retry.");
});

test("createAgentStatusHttpErrorBody maps 5xx user hint and type", () => {
  for (const status of [500, 502, 503]) {
    const body = createAgentStatusHttpErrorBody({
      event: "e",
      message: "m",
      status,
      scope: "http",
      source: "web_http",
    });
    assert.equal(
      body.error.userHint,
      "The server is unavailable or returned an internal error. Retry later or check server logs.",
    );
    assert.equal(body.error.type, "server_error");
  }
});

test("createAgentStatusHttpErrorBody honors explicit type and userHint", () => {
  const body = createAgentStatusHttpErrorBody({
    event: "e",
    message: "m",
    status: 500,
    type: "custom_type",
    userHint: "custom hint",
    scope: "http",
    source: "web_http",
  });
  assert.equal(body.error.type, "custom_type");
  assert.equal(body.error.userHint, "custom hint");
});

test("createAgentStatusHttpErrorBody passes detail through", () => {
  const body: AgentStatusHttpErrorBody = createAgentStatusHttpErrorBody({
    event: "e",
    message: "m",
    status: 429,
    scope: "http",
    source: "web_http",
    detail: { retryAfterMs: 5000 },
  });
  assert.equal(body.agent_status.detail.retryAfterMs, 5000);
  assert.equal(body.agent_status.detail.status, 429);
});

test("isVisibleFailureStatusDetail requires record with visible !== false and severity error", () => {
  assert.equal(isVisibleFailureStatusDetail(null), false);
  assert.equal(isVisibleFailureStatusDetail("x"), false);
  assert.equal(isVisibleFailureStatusDetail({}), false);
  assert.equal(isVisibleFailureStatusDetail({ severity: "error" }), true);
  assert.equal(isVisibleFailureStatusDetail({ severity: "error", visible: true }), true);
  assert.equal(isVisibleFailureStatusDetail({ severity: "error", visible: false }), false);
  assert.equal(isVisibleFailureStatusDetail({ severity: "warning", visible: true }), false);
  assert.equal(isVisibleFailureStatusDetail({ severity: "info" }), false);
});

test("visibleStatusMessage returns message when present, else fallback", () => {
  assert.equal(visibleStatusMessage({ message: "real" }, "fb"), "real");
  assert.equal(visibleStatusMessage({ message: "  " }, "fb"), "fb");
  assert.equal(visibleStatusMessage({ message: 42 }, "fb"), "fb");
  assert.equal(visibleStatusMessage(null, "fb"), "fb");
  assert.equal(visibleStatusMessage("str", "fb"), "fb");
  assert.equal(visibleStatusMessage({}, "fb"), "fb");
});
