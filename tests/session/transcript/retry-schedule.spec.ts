/**
 * 跨进程重启续算 T-A/T-B：retry_schedule 条目、policyKey、findOpenRequest 判定。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";
import type { AgentRequestHeaderSnapshot } from "../../../src/session/transcript/TranscriptEntry.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { JsonlTranscriptWriter } from "../../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../../../src/session/transcript/TranscriptReplay.js";
import { findOpenRequest } from "../../../src/session/transcript/interruptedTurn.js";
import { createPolicyKey, normalizeRetryReason, type RetrySchedule } from "../../../src/model/streaming/retryState.js";

function schedule(overrides: Partial<RetrySchedule> = {}): RetrySchedule {
  return {
    retryId: "r1",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    policyKey: "default",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 500,
    reason: "network_error",
    scheduledAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

function requestHeader(provider: string, model: string): AgentRequestHeaderSnapshot {
  return { provider, model, systemPromptDigest: "abc", toolSchemaDigest: "def", messageCount: 1 };
}

function turnResult(turnId: string): AgentTurnResult {
  return {
    type: "success",
    sessionId: "s1",
    turnId,
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-08-16T00:00:00.000Z",
    completedAt: "2026-08-16T00:01:00.000Z",
  };
}

function entry(
  overrides: Partial<AgentTranscriptEntry> & { type: AgentTranscriptEntry["type"]; turnId: string },
): AgentTranscriptEntry {
  return { sessionId: "s1", sequence: 0, createdAt: "2026-08-16T00:00:00.000Z", ...overrides } as AgentTranscriptEntry;
}

test("createPolicyKey：无配置为 default、稳定、配置变化即变", () => {
  assert.equal(createPolicyKey(undefined), "default");
  assert.equal(createPolicyKey({}), "default");
  const a = createPolicyKey({ baseDelayMs: 500, maxDelayMs: 8000 });
  const b = createPolicyKey({ baseDelayMs: 500, maxDelayMs: 8000 });
  assert.equal(a, b);
  const c = createPolicyKey({ baseDelayMs: 500, maxDelayMs: 16000 });
  assert.notEqual(a, c);
});

test("normalizeRetryReason：四值域保真、router 层原因归并", () => {
  assert.equal(normalizeRetryReason("network_error"), "network_error");
  assert.equal(normalizeRetryReason("rate_limit"), "rate_limit");
  assert.equal(normalizeRetryReason("continuation"), "continuation");
  assert.equal(normalizeRetryReason("zero_usage"), "server_error");
  assert.equal(normalizeRetryReason("overloaded"), "server_error");
  assert.equal(normalizeRetryReason("server_error"), "server_error");
});

test("InMemoryTranscriptWriter.recordRetrySchedule：条目落盘且可回读", () => {
  const writer = new InMemoryTranscriptWriter();
  writer.recordRetrySchedule("s1", "t1", schedule());
  assert.equal(writer.entries.length, 1);
  const e = writer.entries[0]!;
  assert.equal(e.type, "retry_schedule");
  if (e.type === "retry_schedule") {
    assert.equal(e.schedule.retryId, "r1");
    assert.equal(e.schedule.policyKey, "default");
  }
});

test("JsonlTranscriptWriter.recordRetrySchedule：落盘可读回 + 重放 log-only 跳过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-retry-sched-"));
  try {
    const path = join(dir, "s1.jsonl");
    const writer = new JsonlTranscriptWriter({ path });
    await writer.recordAcceptedInput("s1", "t1", []);
    await writer.recordRetrySchedule("s1", "t1", schedule());
    await writer.recordRequestHeader("s1", "t1", {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      systemPromptDigest: "abc",
      toolSchemaDigest: "def",
      messageCount: 1,
    });
    await writer.recordTurnResult("s1", "t1", turnResult("t1"));
    const { entries } = await readTranscript(path);
    const retry = entries.find(e => e.type === "retry_schedule");
    assert.ok(retry, "retry_schedule 条目应可读回");
    if (retry !== undefined && retry.type === "retry_schedule") {
      assert.equal(retry.schedule.retryId, "r1");
    }
    const replay = replayTranscriptEntries(entries);
    assert.ok(replay.messages.length >= 0);
    assert.equal(replay.events.filter(e => e.type === "input_accepted").length, 1, "retry_schedule 不应产生投影事件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findOpenRequest：(a) 形态——request_header 后无 durable，可续算", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "accepted_input", turnId: "t1", messages: [] }),
    entry({
      type: "request_header",
      turnId: "t1",
      sequence: 2,
      header: requestHeader("deepseek", "deepseek-v4-flash"),
    }),
  ];
  const open = findOpenRequest(entries);
  assert.deepEqual(open, { turnId: "t1", provider: "deepseek", model: "deepseek-v4-flash", sequence: 2, form: "a" });
});

test("findOpenRequest：(b) 形态——request_header 后已有部分 durable，不续算", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "accepted_input", turnId: "t1", messages: [] }),
    entry({
      type: "request_header",
      turnId: "t1",
      sequence: 2,
      header: requestHeader("deepseek", "deepseek-v4-flash"),
    }),
    entry({
      type: "durable_message",
      turnId: "t1",
      sequence: 3,
      message: { role: "assistant", content: [{ type: "text", text: "部分响应" }] },
    }),
  ];
  const open = findOpenRequest(entries);
  assert.equal(open?.form, "b");
});

test("findOpenRequest：turn 已闭合（有 turn_result）返回 undefined", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "accepted_input", turnId: "t1", messages: [] }),
    entry({ type: "request_header", turnId: "t1", header: requestHeader("deepseek", "deepseek-v4-flash") }),
    entry({ type: "turn_result", turnId: "t1", result: turnResult("t1") }),
  ];
  assert.equal(findOpenRequest(entries), undefined);
});

test("findOpenRequest：无 request_header 返回 undefined", () => {
  const entries: AgentTranscriptEntry[] = [entry({ type: "accepted_input", turnId: "t1", messages: [] })];
  assert.equal(findOpenRequest(entries), undefined);
});

test("findOpenRequest：多 turn——只返回最后一个开放请求", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "accepted_input", turnId: "t1", messages: [] }),
    entry({ type: "request_header", turnId: "t1", header: requestHeader("deepseek", "deepseek-v4-flash") }),
    entry({ type: "turn_result", turnId: "t1", result: turnResult("t1") }),
    entry({ type: "accepted_input", turnId: "t2", messages: [] }),
    entry({
      type: "request_header",
      turnId: "t2",
      sequence: 9,
      header: requestHeader("openai", "gpt-4o"),
    }),
  ];
  const open = findOpenRequest(entries);
  assert.equal(open?.turnId, "t2");
  assert.equal(open?.provider, "openai");
});
