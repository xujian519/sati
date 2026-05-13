import test from "node:test";
import assert from "node:assert/strict";
import { applyGatewayEventToTuiState } from "../../src/adapters/channel/tui/app/types.js";
import type { TuiEventReducerResult } from "../../src/adapters/channel/tui/app/types.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

function baseState(): TuiEventReducerResult {
  return {
    messages: [],
    activity: [],
    mode: "default",
    isRunning: true,
  };
}

test("tool_call_finished: creates tool message with toolName and lineCount", () => {
  const state: TuiEventReducerResult = {
    ...baseState(),
    activity: [{ id: "tc1", text: "bash", status: "running" }],
  };
  const event: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "tc1",
    ok: true,
    resultPreview: "file1\nfile2\nfile3",
    resultLineCount: 3,
    toolName: "bash",
  };
  const next = applyGatewayEventToTuiState(state, event);
  const last = next.messages.at(-1);
  assert.equal(last?.role, "tool");
  if (last?.role !== "tool") return;
  assert.equal(last.toolName, "bash");
  assert.equal(last.lineCount, 3);
  assert.equal(last.toolCallId, "tc1");
  assert.equal(last.text, "file1\nfile2\nfile3");
  assert.equal(next.activity.length, 0);
});

test("tool_call_finished: empty preview falls back to ok", () => {
  const state = baseState();
  const event: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "tc1",
    ok: true,
    resultPreview: "   ",
  };
  const next = applyGatewayEventToTuiState(state, event);
  const last = next.messages.at(-1);
  if (last?.role === "tool") {
    assert.equal(last.text, "ok");
  }
});

test("tool_result_detail_available: updates matching message with fullText", () => {
  const state: TuiEventReducerResult = {
    ...baseState(),
    messages: [
      { role: "tool", text: "preview", ok: true, toolCallId: "tc1", toolName: "bash" },
    ],
  };
  const event: GatewayEvent = {
    type: "tool_result_detail_available",
    toolCallId: "tc1",
    fullText: "full output line1\nline2\nline3",
  };
  const next = applyGatewayEventToTuiState(state, event);
  const msg = next.messages[0];
  if (msg?.role === "tool") {
    assert.equal(msg.fullText, "full output line1\nline2\nline3");
  }
});

test("tool_result_detail_available: updates matching message with resultPath", () => {
  const state: TuiEventReducerResult = {
    ...baseState(),
    messages: [
      { role: "tool", text: "preview", ok: true, toolCallId: "tc2", toolName: "bash" },
    ],
  };
  const event: GatewayEvent = {
    type: "tool_result_detail_available",
    toolCallId: "tc2",
    resultPath: "/tmp/tc2.txt",
  };
  const next = applyGatewayEventToTuiState(state, event);
  const msg = next.messages[0];
  if (msg?.role === "tool") {
    assert.equal(msg.resultPath, "/tmp/tc2.txt");
  }
});

test("tool_result_detail_available: does not modify non-matching messages", () => {
  const state: TuiEventReducerResult = {
    ...baseState(),
    messages: [
      { role: "tool", text: "other", ok: true, toolCallId: "tc-other", toolName: "read_file" },
    ],
  };
  const event: GatewayEvent = {
    type: "tool_result_detail_available",
    toolCallId: "tc-miss",
    fullText: "should not appear",
  };
  const next = applyGatewayEventToTuiState(state, event);
  const msg = next.messages[0];
  if (msg?.role === "tool") {
    assert.equal(msg.fullText, undefined);
  }
});
