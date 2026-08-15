/**
 * 请求重建 invariant 测试（阶段四 T2）。
 *
 * 覆盖：快照生成确定性、对拍正常/篡改、transcript 独立重建（取最近一条
 * request_header）、缺失条目 fail-loud、重放投影跳过 log-only 条目。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import type { RouterDecision } from "../../../src/router/index.js";
import {
  buildRequestHeaderSnapshot,
  digestForReplay,
  RequestReconstructionInvariantError,
  verifyRequestHeaderSnapshot,
  verifyRequestReconstruction,
} from "../../../src/agent/loop/requestInvariant.js";
import type {
  AgentRequestHeaderTranscriptEntry,
  AgentTranscriptEntry,
} from "../../../src/session/transcript/TranscriptEntry.js";
import { replayTranscriptEntries } from "../../../src/session/transcript/TranscriptReplay.js";

function makeRequest(overrides: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest {
  return {
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    systemPrompt: "you are a patent assistant",
    tools: [{ name: "read_file", inputSchema: { filePath: { type: "string" } } }],
    maxOutputTokens: 4096,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<RouterDecision> = {}): RouterDecision {
  return {
    provider: "deepseek",
    model: "deepseek-chat",
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
    ...overrides,
  };
}

function makeRequestHeaderEntry(
  header: AgentRequestHeaderTranscriptEntry["header"],
  index = 0,
): AgentRequestHeaderTranscriptEntry {
  return {
    type: "request_header",
    sessionId: "s1",
    turnId: "t1",
    sequence: index,
    createdAt: "2026-08-16T00:00:00.000Z",
    header,
  };
}

test("快照生成确定：同请求同摘要，raw 与 metadata 不影响摘要", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const first = buildRequestHeaderSnapshot(request, decision);
  const second = buildRequestHeaderSnapshot(makeRequest(), makeDecision());
  assert.deepEqual(first, second);
  const withRaw = makeRequest();
  withRaw.messages[0]!.content = [
    { type: "text", text: "hello", raw: { internal: true } } as unknown as (typeof withRaw.messages)[0]["content"][0],
  ];
  assert.equal(buildRequestHeaderSnapshot(withRaw, decision).systemPromptDigest, first.systemPromptDigest);
  assert.equal(buildRequestHeaderSnapshot(withRaw, decision).toolSchemaDigest, first.toolSchemaDigest);
  assert.equal(digestForReplay({ a: 1, raw: 2 }), digestForReplay({ a: 1 }));
});

test("对拍通过：快照与重建期望一致", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const snapshot = buildRequestHeaderSnapshot(request, decision);
  verifyRequestHeaderSnapshot(snapshot, request, decision);
});

test("对拍失败：篡改字段报错并点名", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const snapshot = buildRequestHeaderSnapshot(request, decision);
  const tampered = { ...snapshot, maxOutputTokens: 99999 };
  assert.throws(
    () => verifyRequestHeaderSnapshot(tampered, request, decision),
    (error: unknown) =>
      error instanceof RequestReconstructionInvariantError && error.mismatchedFields.includes("maxOutputTokens"),
  );
  const tamperedModel = { ...snapshot, model: "other-model" };
  assert.throws(
    () => verifyRequestHeaderSnapshot(tamperedModel, request, decision),
    (error: unknown) =>
      error instanceof RequestReconstructionInvariantError && error.mismatchedFields.includes("model"),
  );
});

test("transcript 重建：取最近一条 request_header 并验证", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const snapshot = buildRequestHeaderSnapshot(request, decision);
  const entries: AgentTranscriptEntry[] = [
    makeRequestHeaderEntry({ ...snapshot, maxOutputTokens: 1111 }, 0),
    makeRequestHeaderEntry(snapshot, 1),
  ];
  const rebuilt = verifyRequestReconstruction(entries, request, decision);
  assert.equal(rebuilt.maxOutputTokens, 4096);
});

test("transcript 重建：篡改持久化条目必报、缺失条目 fail-loud", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const snapshot = buildRequestHeaderSnapshot(request, decision);
  const tampered = { ...snapshot, systemPromptDigest: digestForReplay("other prompt") };
  assert.throws(
    () => verifyRequestReconstruction([makeRequestHeaderEntry(tampered)], request, decision),
    (error: unknown) =>
      error instanceof RequestReconstructionInvariantError && error.mismatchedFields.includes("systemPromptDigest"),
  );
  assert.throws(
    () => verifyRequestReconstruction([], request, decision),
    (error: unknown) => error instanceof RequestReconstructionInvariantError && error.mismatchedFields.length === 0,
  );
});

test("重放投影：request_header 为 log-only，不进入模型可见 messages", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const snapshot = buildRequestHeaderSnapshot(request, decision);
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "s1",
      turnId: "t1",
      sequence: 0,
      createdAt: "2026-08-16T00:00:00.000Z",
      messages: request.messages,
    },
    makeRequestHeaderEntry(snapshot, 1),
  ];
  const projected = replayTranscriptEntries(entries);
  // request_header 是 log-only 参考条目：不产生任何模型可见消息。
  assert.equal(projected.messages.length, 1);
  assert.equal(projected.messages[0]!.role, "user");
});
