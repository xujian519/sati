import test from "node:test";
import assert from "node:assert/strict";
import { applyGatewayEventToTuiState } from "../../src/adapters/channel/tui/app/types.js";

test("TUI reducer renders Claude Code style assistant and tool events", () => {
  const state = {
    messages: [],
    activity: [],
    mode: "default" as const,
    isRunning: false,
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
    { role: "tool", text: "ok", ok: true },
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
  };
  const next = applyGatewayEventToTuiState(state, { type: "assistant_text_delta", text: "" });
  assert.deepEqual(next.messages, []);
});
