import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../../src/gateway/client/eventMapping.js";

/**
 * 有界轮询等待文件出现。落盘是 fire-and-forget（`mapAgentEvent` 同步返回路径、
 * 写盘在其后的 async IIFE 里完成，见 `src/gateway/client/eventMapping.ts`），
 * 故「等一个固定时长再断言」没有完成通知可依 —— CI 负载下会偶发跑在写入完成前
 * （2026-09-15 push CI 实例：100ms 预算内 mkdir+writeFile 双双未完成）。
 * 手法与 `tests/session/transcript/jsonl-writer.spec.ts` 的 `waitFor` 一致。
 */
async function waitForFile(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 10));
  }
}

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
  // 落盘异步进行——轮询等待文件出现（不要改成固定 sleep：见 waitForFile 注释）。
  assert.ok(
    await waitForFile(finished.resultPath!),
    `落盘文件未在超时内出现（事件已带 resultPath，但写盘未完成或 best-effort 写失败）：${finished.resultPath}`,
  );
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

test("eventMapping: context_budget 透传固定开销（system prompt + 工具 schema）", () => {
  const snapshot = {
    tokens: 40_000,
    displayTokens: 38_000,
    fixedOverheadTokens: 34_000,
    totalContextTokens: 131_072,
    maxContextTokens: 98_304,
    effectiveContextTokens: 98_304,
    reservedOutputTokens: 32_768,
    warningRatio: 0.8,
    blockingRatio: 0.95,
    state: "ok" as const,
    ratio: 0.4,
  };
  const mapped = mapAgentEvent(
    { type: "context_budget", sessionId: "s", turnId: "t", snapshot } as unknown as AgentEvent,
    "run-1",
  );

  assert.equal(mapped[0]?.type, "context_budget");
  assert.equal((mapped[0] as { fixedOverheadTokens?: number }).fixedOverheadTokens, 34_000);
});

test("eventMapping: 快照未带固定开销时不凭空编造该字段", () => {
  const mapped = mapAgentEvent(
    {
      type: "context_budget",
      sessionId: "s",
      turnId: "t",
      snapshot: {
        tokens: 1_000,
        totalContextTokens: 131_072,
        maxContextTokens: 98_304,
        warningRatio: 0.8,
        blockingRatio: 0.95,
        state: "ok" as const,
        ratio: 0.01,
      },
    } as unknown as AgentEvent,
    "run-1",
  );

  assert.equal(mapped[0]?.type, "context_budget");
  // 归一化后为 undefined：帧序列化（JSON）会丢掉该键，旧客户端看到的形状与拆分前一致。
  assert.equal((mapped[0] as { fixedOverheadTokens?: number }).fixedOverheadTokens, undefined);
});
