// heartbeat-helpers 行为基线测试（从 heartbeat.ts 拆出，函数体逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCandidateMemoryPreview,
  buildGeneralProjectShortlist,
  buildIndexTraceId,
  commonPrefixLength,
  createBatchTrace,
  deriveFocusTurns,
  hasNewContent,
  mergeSessionMessages,
  normalizeTrigger,
  sameMessage,
  tokenizeSearchText,
} from "../../src/core/pipeline/heartbeat-helpers.js";
import type { L0SessionRecord, MemoryMessage, ReadableProjectCatalogEntry } from "../../src/core/types.js";

const msg = (role: "user" | "assistant", content: string): MemoryMessage => ({ role, content }) as MemoryMessage;

describe("sameMessage", () => {
  it("同 role+content 相等", () => {
    assert.equal(sameMessage(msg("user", "a"), msg("user", "a")), true);
  });
  it("role 或 content 不同不相等", () => {
    assert.equal(sameMessage(msg("user", "a"), msg("assistant", "a")), false);
    assert.equal(sameMessage(msg("user", "a"), msg("user", "b")), false);
  });
  it("空值不相等", () => {
    assert.equal(sameMessage(undefined, msg("user", "a")), false);
  });
});

describe("hasNewContent", () => {
  it("空 incoming 无新内容", () => {
    assert.equal(hasNewContent([msg("user", "a")], []), false);
  });
  it("空 previous 有新内容", () => {
    assert.equal(hasNewContent([], [msg("user", "a")]), true);
  });
  it("incoming 更长有新内容", () => {
    assert.equal(hasNewContent([msg("user", "a")], [msg("user", "a"), msg("user", "b")]), true);
  });
  it("相同前缀但后续不同有新内容", () => {
    assert.equal(hasNewContent([msg("user", "a"), msg("user", "x")], [msg("user", "a"), msg("user", "y")]), true);
  });
  it("完全一致无新内容", () => {
    assert.equal(hasNewContent([msg("user", "a")], [msg("user", "a")]), false);
  });
});

describe("mergeSessionMessages 前缀合并语义", () => {
  it("空 previous：incoming 全为新", () => {
    assert.deepEqual(mergeSessionMessages([], [msg("user", "a")]), {
      mergedMessages: [msg("user", "a")],
      newMessages: [msg("user", "a")],
    });
  });
  it("前缀命中：合并为 incoming，新消息为前缀后部分", () => {
    const result = mergeSessionMessages(
      [msg("user", "a"), msg("assistant", "b")],
      [msg("user", "a"), msg("assistant", "b"), msg("user", "c")],
    );
    assert.deepEqual(result.mergedMessages, [msg("user", "a"), msg("assistant", "b"), msg("user", "c")]);
    assert.deepEqual(result.newMessages, [msg("user", "c")]);
  });
  it("前缀未命中：前后拼接，incoming 全为新", () => {
    const result = mergeSessionMessages([msg("user", "x")], [msg("user", "y")]);
    assert.deepEqual(result.mergedMessages, [msg("user", "x"), msg("user", "y")]);
    assert.deepEqual(result.newMessages, [msg("user", "y")]);
  });
});

describe("commonPrefixLength", () => {
  it("相同前缀长度", () => {
    assert.equal(commonPrefixLength([msg("user", "a"), msg("user", "b")], [msg("user", "a"), msg("user", "c")]), 1);
  });
});

describe("deriveFocusTurns", () => {
  it("逐 session 合并并取新增 user 消息", () => {
    const sessions: L0SessionRecord[] = [
      { l0IndexId: "s1", timestamp: "2026-01-01T00:00:00Z", messages: [msg("user", "a")] },
    ] as L0SessionRecord[];
    const focus = deriveFocusTurns([], sessions);
    assert.deepEqual(focus.get("s1"), [msg("user", "a")]);
  });
});

describe("tokenizeSearchText", () => {
  it("英文分词 + 过滤停用词与短词", () => {
    const tokens = tokenizeSearchText("general project alpha");
    assert.ok(!tokens.includes("general"), "停用词应被过滤");
    assert.ok(tokens.includes("alpha"));
  });
  it("CJK 展开 2/3-gram", () => {
    const tokens = tokenizeSearchText("专利检索");
    assert.ok(tokens.includes("专利"));
    assert.ok(tokens.includes("利检"));
    assert.ok(tokens.includes("专利检"));
  });
  it("去重", () => {
    const tokens = tokenizeSearchText("alpha alpha");
    assert.equal(tokens.filter(t => t === "alpha").length, 1);
  });
});

describe("buildGeneralProjectShortlist 打分排序", () => {
  const catalog: ReadableProjectCatalogEntry[] = [
    {
      projectId: "p1",
      projectName: "Alpha 项目",
      description: "检索",
      status: "in_progress",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      relativePath: "projects/p1/meta.md",
      absolutePath: "/tmp/projects/p1/meta.md",
      workspaceMode: "single",
      workspacePath: "/tmp",
      workspaceName: "tmp",
      sourceType: "workspace_external",
      logicalProjectId: "p1",
      readOnly: true,
      hasLocalMirror: true,
      summary: { totalEntries: 0, projectEntries: 0, feedbackEntries: 0, latestMemoryAt: "2026-01-02T00:00:00Z" },
    },
    {
      projectId: "p2",
      projectName: "Beta 项目",
      description: "无关描述",
      status: "planned",
      createdAt: "2026-01-03T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
      relativePath: "projects/p2/meta.md",
      absolutePath: "/tmp/projects/p2/meta.md",
      workspaceMode: "single",
      workspacePath: "/tmp",
      workspaceName: "tmp",
      sourceType: "general_local",
      logicalProjectId: "p2",
      readOnly: false,
      hasLocalMirror: false,
      summary: { totalEntries: 0, projectEntries: 0, feedbackEntries: 0 },
    },
  ];
  it("命中查询词的项目排前", () => {
    const result = buildGeneralProjectShortlist(catalog, "Alpha 检索");
    assert.equal(result[0]?.projectId, "p1");
    assert.ok((result[0]?.score ?? 0) > (result[1]?.score ?? 0));
  });
  it("无命中按 updatedAt 降序且标记 recent", () => {
    const result = buildGeneralProjectShortlist(catalog, "zzzqqq");
    assert.equal(result[0]?.projectId, "p2");
    assert.equal(result[0]?.source, "recent");
  });
});

describe("buildCandidateMemoryPreview", () => {
  it("project 候选渲染标题/类型/描述", () => {
    const preview = buildCandidateMemoryPreview({
      type: "project",
      scope: "project",
      name: "P",
      description: "D",
    });
    assert.ok(preview.includes("# P"));
    assert.ok(preview.includes("type: project"));
  });
  it("feedback 候选渲染 Rule/Why/How", () => {
    const preview = buildCandidateMemoryPreview({
      type: "feedback",
      scope: "project",
      name: "F",
      description: "D",
      rule: "R",
      why: "W",
      howToApply: "H",
    });
    assert.ok(preview.includes("## Rule"));
    assert.ok(preview.includes("## Why"));
    assert.ok(preview.includes("## How To Apply"));
  });
});

describe("createBatchTrace / buildIndexTraceId / normalizeTrigger", () => {
  const session: L0SessionRecord = {
    l0IndexId: "l0-1",
    timestamp: "2026-01-01T00:00:00Z",
    messages: [msg("user", "a")],
  } as L0SessionRecord;
  it("trace 骨架正确（running/空 steps/批量汇总）", () => {
    const trace = createBatchTrace("sk", [session], "manual_sync", 1);
    assert.equal(trace.sessionKey, "sk");
    assert.equal(trace.status, "running");
    assert.equal(trace.isNoOp, false);
    assert.equal(trace.steps.length, 0);
    assert.equal(trace.batchSummary.segmentCount, 1);
    assert.equal(trace.batchSummary.fromTimestamp, "2026-01-01T00:00:00Z");
  });
  it("buildIndexTraceId 格式 + 确定性 + 输入区分", () => {
    const traceId = buildIndexTraceId("sk", "2026-01-01T00:00:00Z", ["l0-1"]);
    assert.match(traceId, /^index_trace_[0-9a-f]{10}$/);
    assert.equal(traceId, buildIndexTraceId("sk", "2026-01-01T00:00:00Z", ["l0-1"]));
    assert.notEqual(traceId, buildIndexTraceId("other-sk", "2026-01-01T00:00:00Z", ["l0-1"]));
    assert.notEqual(traceId, buildIndexTraceId("sk", "2026-01-01T00:00:00Z", ["l0-2"]));
  });
  it("normalizeTrigger 映射 scheduled/manual_sync", () => {
    assert.equal(normalizeTrigger("scheduled run"), "scheduled");
    assert.equal(normalizeTrigger("manual"), "manual_sync");
    assert.equal(normalizeTrigger(undefined), "manual_sync");
  });
});
