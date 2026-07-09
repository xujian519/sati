import test from "node:test";
import assert from "node:assert/strict";

import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

const largeOutput = `head-${"x".repeat(120_000)}-tail`;

function textToolResultEvent(): AgentEvent {
  return {
    type: "tool_result",
    sessionId: "session-1",
    turnId: "turn-1",
    result: {
      type: "success",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: largeOutput }],
      startedAt: "2026-07-09T00:00:00.000Z",
      completedAt: "2026-07-09T00:00:01.000Z",
    },
  };
}

function toolResultPayload(): Extract<AgentEvent, { type: "tool_result" }>["result"] {
  return (textToolResultEvent() as Extract<AgentEvent, { type: "tool_result" }>).result;
}

test("mapAgentEvent bounds live tool result previews at the gateway", () => {
  const frames = mapAgentEvent(textToolResultEvent(), "run-1");
  const frame = frames.find((event) => event.type === "tool_call_finished");

  assert.ok(frame);
  assert.ok(frame.resultPreview);
  assert.ok(frame.resultPreview.length < largeOutput.length);
  assert.ok(frame.resultPreview.length <= 21_000);
  assert.match(frame.resultPreview, /Gateway preview truncated/);
  assert.match(frame.resultPreview, /^head-/);
  assert.match(frame.resultPreview, /-tail$/);
  assert.equal(frame.resultBytes, Buffer.byteLength(largeOutput, "utf8"));
});

test("mapAgentEvent bounds subagent tool result content and preview", () => {
  const frames = mapAgentEvent({
    type: "subagent_tool_result",
    sessionId: "session-1",
    turnId: "turn-1",
    subagentId: "sub-1",
    subagentType: "explore",
    result: toolResultPayload(),
  }, "run-1");
  const frame = frames.find((event): event is Extract<GatewayEvent, { type: "agent_status" }> =>
    event.type === "agent_status" && event.event === "subagent_tool_result"
  );

  assert.ok(frame);
  const detail = frame.detail as { content?: string; preview?: string; resultBytes?: number };
  assert.ok(detail.content);
  assert.ok(detail.preview);
  assert.ok(detail.content.length <= 21_000);
  assert.ok(detail.preview.length <= 21_000);
  assert.match(detail.content, /Gateway preview truncated/);
  assert.equal(detail.resultBytes, Buffer.byteLength(largeOutput, "utf8"));
});
