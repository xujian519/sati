/**
 * 请求重建 invariant 测试（阶段四 T2；派发点对拍为 #360 修复）。
 *
 * 覆盖：快照生成确定性、比较器正常/篡改、transcript 独立重建（取最近一条
 * request_header）、缺失条目 fail-loud、重放投影跳过 log-only 条目，以及
 * **派发点对拍**（零误报 / 声明的差异 / 未声明的差异必报 / 字段全集覆盖）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import type { RouterDecision, RouterDispatchReport, RouterTransformTag } from "../../../src/router/index.js";
import {
  buildRequestHeaderSnapshot,
  diffRequestHeaderSnapshots,
  digestForReplay,
  RequestReconstructionInvariantError,
  verifyDispatchedRequest,
  verifyRequestHeaderSnapshot,
  verifyRequestReconstruction,
} from "../../../src/agent/loop/requestInvariant.js";
import type {
  AgentRequestHeaderSnapshot,
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

/**
 * 造一个「快照在 `field` 上与基线不同」的派发报告入参。
 *
 * `switch` 覆盖 `keyof AgentRequestHeaderSnapshot` 全集且无 `default`：将来给快照
 * 新增字段却忘了在此登记会**编译失败**，不会静默漏测。
 */
function drift(field: keyof AgentRequestHeaderSnapshot): {
  request: CanonicalModelRequest;
  decision: RouterDecision;
} {
  switch (field) {
    case "provider":
      return { request: makeRequest(), decision: makeDecision({ provider: "other-provider" }) };
    case "model":
      return { request: makeRequest(), decision: makeDecision({ model: "other-model" }) };
    case "maxOutputTokens":
      return { request: makeRequest({ maxOutputTokens: 111 }), decision: makeDecision() };
    case "systemPromptDigest":
      return { request: makeRequest({ systemPrompt: "别的系统提示" }), decision: makeDecision() };
    case "toolSchemaDigest":
      return { request: makeRequest({ tools: [] }), decision: makeDecision() };
    case "messageCount":
      return { request: makeRequest({ messages: [] }), decision: makeDecision() };
  }
}

function reportFor(
  drifted: { request: CanonicalModelRequest; decision: RouterDecision },
  transforms: readonly RouterTransformTag[],
): RouterDispatchReport {
  return { request: drifted.request, decision: drifted.decision, transforms };
}

test("派发对拍：零差异通过，声明的差异通过并回报字段", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const persisted = buildRequestHeaderSnapshot(request, decision);

  // 直通形态：派发请求与落盘装配态逐字段相同。
  const clean = verifyDispatchedRequest({
    persisted,
    report: { request: makeRequest(), decision, transforms: [] },
  });
  assert.deepEqual(clean, { diverged: [], declared: [] });

  // 输出上限被夹取：差异落在已声明字段上，放行且如实回报。
  const clamped = verifyDispatchedRequest({
    persisted,
    report: reportFor({ request: makeRequest({ maxOutputTokens: 2048 }), decision }, ["maxOutputTokensClamped"]),
  });
  assert.deepEqual(clamped, { diverged: ["maxOutputTokens"], declared: ["maxOutputTokens"] });
});

test("派发对拍：未声明的差异必报——工具集被静默过滤（#360 要抓的那类漂移）", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const persisted = buildRequestHeaderSnapshot(request, decision);

  // 派发前工具集被改掉，却没有任何标签声明它。旧实现（同一对入参自比）恒真放行。
  assert.throws(
    () =>
      verifyDispatchedRequest({
        persisted,
        report: reportFor(drift("toolSchemaDigest"), []),
      }),
    (error: unknown) =>
      error instanceof RequestReconstructionInvariantError &&
      error.mismatchedFields.length === 1 &&
      error.mismatchedFields[0] === "toolSchemaDigest",
  );
});

test("派发对拍：已声明与未声明混在一起时，只点名未声明的那个", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const persisted = buildRequestHeaderSnapshot(request, decision);
  // 一次派发里同时改了输出上限（有标签）与工具集（无标签）。
  const drifted = {
    request: makeRequest({ maxOutputTokens: 2048, tools: [] }),
    decision,
  };

  assert.throws(
    () =>
      verifyDispatchedRequest({
        persisted,
        report: reportFor(drifted, ["maxOutputTokensClamped"]),
      }),
    (error: unknown) =>
      error instanceof RequestReconstructionInvariantError && error.mismatchedFields.join(",") === "toolSchemaDigest",
  );
});

test("派发对拍：标签只放行它自己声明的字段（表驱动，防映射表过宽）", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const persisted = buildRequestHeaderSnapshot(request, decision);
  const cases: ReadonlyArray<{
    tag: RouterTransformTag;
    allowed: keyof AgentRequestHeaderSnapshot;
    forbidden: keyof AgentRequestHeaderSnapshot;
  }> = [
    { tag: "fallbackAttempt", allowed: "provider", forbidden: "toolSchemaDigest" },
    { tag: "mediaDowngraded", allowed: "messageCount", forbidden: "systemPromptDigest" },
    { tag: "subagentTagStripped", allowed: "messageCount", forbidden: "maxOutputTokens" },
    { tag: "maxOutputTokensClamped", allowed: "maxOutputTokens", forbidden: "messageCount" },
    { tag: "requestPatch:messages", allowed: "messageCount", forbidden: "toolSchemaDigest" },
    { tag: "requestPatch:tools", allowed: "toolSchemaDigest", forbidden: "messageCount" },
    { tag: "requestPatch:systemPrompt", allowed: "systemPromptDigest", forbidden: "messageCount" },
  ];

  for (const { tag, allowed, forbidden } of cases) {
    // 声明过的字段放行，并被回报为 declared。
    const declared = verifyDispatchedRequest({
      persisted,
      report: reportFor(drift(allowed), [tag]),
    });
    assert.deepEqual(declared.declared, [allowed], `${tag} 应放行 ${allowed}`);

    // 同一标签下、未声明字段的差异仍须转红：否则映射表已宽到掩盖真实漂移。
    assert.throws(
      () => verifyDispatchedRequest({ persisted, report: reportFor(drift(forbidden), [tag]) }),
      (error: unknown) =>
        error instanceof RequestReconstructionInvariantError && error.mismatchedFields.join(",") === forbidden,
      `${tag} 不得放行 ${forbidden}`,
    );
  }
});

test("派发对拍：差异字段按稳定顺序回报（多条差异时顺序可预期）", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const persisted = buildRequestHeaderSnapshot(request, decision);
  const { diverged } = verifyDispatchedRequest({
    persisted,
    report: reportFor(
      { request: makeRequest({ maxOutputTokens: 2048, tools: [] }), decision: makeDecision({ model: "other" }) },
      ["maxOutputTokensClamped", "requestPatch:tools", "fallbackAttempt"],
    ),
  });
  assert.deepEqual(diverged, ["model", "maxOutputTokens", "toolSchemaDigest"]);
});

test("比较器口径：diff 覆盖全部快照字段", () => {
  const request = makeRequest();
  const decision = makeDecision();
  const base = buildRequestHeaderSnapshot(request, decision);
  // `drift()` 的 switch 若漏掉某个字段，其 case 消失 → 这里会少一项。
  const fields: ReadonlyArray<keyof AgentRequestHeaderSnapshot> = [
    "provider",
    "model",
    "maxOutputTokens",
    "systemPromptDigest",
    "toolSchemaDigest",
    "messageCount",
  ];
  assert.deepEqual(Object.keys(base).sort(), [...fields].sort(), "快照字段集变化时须同步更新本用例");
  for (const field of fields) {
    assert.deepEqual(
      diffRequestHeaderSnapshots(base, buildRequestHeaderSnapshot(drift(field).request, drift(field).decision)),
      [field],
      `字段 ${field} 未被差异函数报告 ⇒ 该字段上的漂移对判据不可见`,
    );
  }
});
