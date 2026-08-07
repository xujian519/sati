import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";

test("mapAgentEvent propagates runId to streaming lifecycle boundaries", () => {
  const runId = "run-1";

  const toolStarted = mapAgentEvent(
    {
      type: "tool_calls_detected",
      sessionId: "session-1",
      turnId: "turn-1",
      calls: [{ id: "call-1", name: "bash", input: { command: "pwd" } }],
    } as unknown as AgentEvent,
    runId,
  );
  assert.equal(toolStarted[0]?.type, "tool_call_started");
  assert.equal(toolStarted[0]?.runId, runId);

  const completed = mapAgentEvent(
    {
      type: "turn_completed",
      sessionId: "session-1",
      turnId: "turn-1",
      result: {
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    } as unknown as AgentEvent,
    runId,
  );
  assert.equal(completed[0]?.type, "turn_completed");
  assert.equal(completed[0]?.runId, runId);

  const failed = mapAgentEvent(
    {
      type: "turn_failed",
      sessionId: "session-1",
      turnId: "turn-1",
      error: { code: "model_error", message: "boom" },
    } as unknown as AgentEvent,
    runId,
  );
  assert.equal(failed[0]?.type, "error");
  assert.equal(failed[0]?.runId, runId);
});

test("mapAgentEvent forwards compactionId and trigger on compaction lifecycle events", () => {
  const runId = "run-2";

  const started = mapAgentEvent(
    {
      type: "compact_started",
      sessionId: "session-1",
      turnId: "turn-1",
      compactionId: "compact-test-1",
      trigger: "auto",
      preTokens: 120,
    },
    runId,
  );
  assert.equal(started[0]?.type, "agent_status");
  const startedDetail = (started[0] as { detail?: Record<string, unknown> })?.detail ?? {};
  assert.equal(startedDetail.compactionId, "compact-test-1");
  assert.equal(startedDetail.trigger, "auto");
  assert.equal(startedDetail.preTokens, 120);

  const completed = mapAgentEvent(
    {
      type: "compact_completed",
      sessionId: "session-1",
      turnId: "turn-1",
      compactionId: "compact-test-1",
      trigger: "reactive",
      status: "success",
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 7,
    },
    runId,
  );
  assert.equal(completed[0]?.type, "agent_status");
  const completedDetail = (completed[0] as { detail?: Record<string, unknown> })?.detail ?? {};
  assert.equal(completedDetail.compactionId, "compact-test-1");
  assert.equal(completedDetail.trigger, "reactive");
  assert.equal(completedDetail.messagesSummarized, 7);
});
