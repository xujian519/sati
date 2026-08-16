import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../../src/gateway/client/eventMapping.js";

test("eventMapping: turn_completed 顺序产出 structured_output 后 turn_completed", () => {
  const events = mapAgentEvent(
    {
      type: "turn_completed",
      sessionId: "s1",
      turnId: "t1",
      result: {
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        structuredOutput: { verdict: "novel" },
      },
    } as unknown as AgentEvent,
    "run-1",
  );
  assert.equal(events[0]?.type, "structured_output");
  assert.deepEqual((events[0] as { payload: unknown }).payload, { verdict: "novel" });
  assert.equal(events[1]?.type, "turn_completed");
  assert.equal(events[0]?.runId, "run-1");
});

test("eventMapping: tool_result 大结果触发 tmp 落盘 resultPath（best-effort）", async () => {
  const events = mapAgentEvent(
    {
      type: "tool_result",
      sessionId: "s1",
      turnId: "t1",
      result: {
        toolCallId: "call-1",
        toolName: "bash",
        type: "success",
        content: [{ type: "text", text: "x".repeat(10_000) }],
      },
    } as unknown as AgentEvent,
    "run-1",
  );
  const finished = events[0] as { type: string; resultPath?: string };
  assert.equal(finished.type, "tool_call_finished");
  assert.ok(finished.resultPath, "超过 4096 字节的大结果应落盘并带 resultPath");
  assert.match(finished.resultPath ?? "", /sati-tool-results/);
  // 落盘异步进行——等待片刻后断言文件存在
  await new Promise(r => setTimeout(r, 100));
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(finished.resultPath!), "tmp 文件应实际写入");
});

test("eventMapping: 未映射事件返回空数组", () => {
  assert.deepEqual(
    mapAgentEvent({ type: "permission_denied", sessionId: "s1", turnId: "t1" } as unknown as AgentEvent, "run-1"),
    [],
  );
  assert.deepEqual(
    mapAgentEvent({ type: "stop_requested", sessionId: "s1", turnId: "t1" } as unknown as AgentEvent, "run-1"),
    [],
  );
});

test("eventMapping: turn_failed 携带 providerError 映射", () => {
  const events = mapAgentEvent(
    {
      type: "turn_failed",
      sessionId: "s1",
      turnId: "t1",
      error: { code: "provider_error", message: "boom", details: { provider: "anthropic", status: 500 } },
    } as unknown as AgentEvent,
    "run-1",
  );
  const err = events[0] as { type: string; providerError?: { provider: string; status: number } };
  assert.equal(err.type, "error");
  assert.equal(err.providerError?.provider, "anthropic");
  assert.equal(err.providerError?.status, 500);
});
