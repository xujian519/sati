import test from "node:test";
import assert from "node:assert/strict";
import { applyGatewayEventToTuiState } from "../../src/adapters/channel/tui/app/types.js";

test("TUI reducer renders Claude Code style assistant and tool events", () => {
  const state = {
    messages: [],
    activity: [],
    mode: "default" as const,
    isRunning: false,
    pendingPermissions: [],
  };

  const started = applyGatewayEventToTuiState(state, { type: "turn_started", runId: "run-1" });
  assert.deepEqual(started.activity, []);
  assert.equal(started.isRunning, true);

  const assistant = applyGatewayEventToTuiState(started, { type: "assistant_text_delta", text: "hello" });
  assert.deepEqual(assistant.messages, [{ role: "assistant", text: "hello" }]);

  const tool = applyGatewayEventToTuiState(assistant, {
    type: "tool_call_started",
    toolCallId: "tool-1",
    name: "read_file",
  });
  assert.equal(tool.activity[0]?.status, "running");

  const finished = applyGatewayEventToTuiState(tool, {
    type: "tool_call_finished",
    toolCallId: "tool-1",
    ok: true,
    resultPreview: "ok",
  });

  assert.deepEqual(finished.messages, [
    { role: "assistant", text: "hello" },
    { role: "tool", text: "ok", ok: true, toolCallId: "tool-1", toolName: undefined, lineCount: undefined, resultPath: undefined },
  ]);
  assert.deepEqual(finished.activity, []);

  const completed = applyGatewayEventToTuiState(finished, {
    type: "turn_completed",
    usage: {},
    finishReason: "completed",
  });
  assert.equal(completed.isRunning, false);
  assert.deepEqual(completed.activity, []);
});

test("TUI reducer ignores empty assistant text deltas", () => {
  const state = {
    messages: [],
    activity: [],
    mode: "default" as const,
    isRunning: true,
    pendingPermissions: [],
  };
  const next = applyGatewayEventToTuiState(state, { type: "assistant_text_delta", text: "" });
  assert.deepEqual(next.messages, []);
});

test("permission_request enqueues to pendingPermissions", () => {
  const state = {
    messages: [],
    activity: [],
    mode: "default" as const,
    isRunning: true,
    pendingPermissions: [],
  };
  const next = applyGatewayEventToTuiState(state, {
    type: "permission_request",
    requestId: "req-1",
    toolName: "bash",
    payload: { command: "npm test" },
  });
  assert.equal(next.pendingPermissions.length, 1);
  assert.deepEqual(next.pendingPermissions[0], {
    requestId: "req-1",
    toolName: "bash",
    payload: { command: "npm test" },
  });
  assert.equal(next.activity[0]?.text, "permission: bash");
});

test("concurrent permission_requests queue without overwriting", () => {
  const state = {
    messages: [],
    activity: [],
    mode: "default" as const,
    isRunning: true,
    pendingPermissions: [],
  };
  const after1 = applyGatewayEventToTuiState(state, {
    type: "permission_request",
    requestId: "req-1",
    toolName: "web_search",
    payload: { query: "first" },
  });
  const after2 = applyGatewayEventToTuiState(after1, {
    type: "permission_request",
    requestId: "req-2",
    toolName: "web_fetch",
    payload: { url: "https://example.com" },
  });
  assert.equal(after2.pendingPermissions.length, 2);
  assert.equal(after2.pendingPermissions[0]!.requestId, "req-1");
  assert.equal(after2.pendingPermissions[1]!.requestId, "req-2");
});

test("turn_completed clears all pendingPermissions", () => {
  const state = {
    messages: [],
    activity: [],
    mode: "default" as const,
    isRunning: true,
    pendingPermissions: [
      { requestId: "req-1", toolName: "web_search", payload: {} },
      { requestId: "req-2", toolName: "web_fetch", payload: {} },
    ],
  };
  const next = applyGatewayEventToTuiState(state, {
    type: "turn_completed",
    usage: {},
    finishReason: "completed",
  });
  assert.deepEqual(next.pendingPermissions, []);
  assert.equal(next.isRunning, false);
});
