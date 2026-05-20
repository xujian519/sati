import test from "node:test";
import assert from "node:assert/strict";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";

function makeToolResult(opts: {
  toolCallId?: string;
  toolName?: string;
  type?: "success" | "error";
  content?: Array<
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; data: string; bytes?: number; detail?: "auto" | "low" | "high" }
  >;
}): AgentEvent {
  const base = {
    toolCallId: opts.toolCallId ?? "tc1",
    toolName: opts.toolName ?? "bash",
    content: opts.content ?? [{ type: "text" as const, text: "hello world" }],
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
  };
  const result =
    opts.type === "error"
      ? { ...base, type: "error" as const, error: { code: "tool_execution_failed" as const, message: "failed" } }
      : { ...base, type: "success" as const };
  return {
    type: "tool_result",
    sessionId: "s1",
    turnId: "t1",
    result,
  };
}

test("tool_result: short output (<=4 lines) preserves full text", () => {
  const events = mapAgentEvent(
    makeToolResult({ content: [{ type: "text", text: "line1\nline2\nline3" }] }),
    "run1",
  );
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.type, "tool_call_finished");
  if (e.type !== "tool_call_finished") return;
  assert.equal(e.resultPreview, "line1\nline2\nline3");
  assert.equal(e.resultLineCount, 3);
  assert.equal(e.ok, true);
  assert.equal(e.toolName, "bash");
});

test("tool_result: exactly 4 lines preserved", () => {
  const events = mapAgentEvent(
    makeToolResult({ content: [{ type: "text", text: "a\nb\nc\nd" }] }),
    "run1",
  );
  const e = events[0]!;
  if (e.type !== "tool_call_finished") return;
  assert.equal(e.resultPreview, "a\nb\nc\nd");
  assert.equal(e.resultLineCount, 4);
});

test("tool_result: >5 lines produces first-5-lines preview", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const events = mapAgentEvent(
    makeToolResult({ content: [{ type: "text", text: lines }] }),
    "run1",
  );
  const e = events[0]!;
  if (e.type !== "tool_call_finished") return;
  assert.equal(e.resultLineCount, 50);
  assert.equal(e.resultPreview, "line 1\nline 2\nline 3\nline 4\nline 5");
});

test("tool_result: empty content returns empty preview", () => {
  const ok = mapAgentEvent(
    makeToolResult({ content: [{ type: "text", text: "" }] }),
    "run1",
  );
  if (ok[0]!.type === "tool_call_finished") {
    assert.equal(ok[0]!.resultPreview, "");
    assert.equal(ok[0]!.resultLineCount, 1);
  }
});

test("tool_result: image content surfaces as inline images on tool_call_finished", () => {
  const events = mapAgentEvent(
    makeToolResult({
      toolName: "read_file",
      content: [
        { type: "text", text: "[Image file: /tmp/a.png]" },
        { type: "image", mimeType: "image/png", data: "abc", bytes: 3 },
        { type: "image", mimeType: "image/jpeg", data: "def", bytes: 3, detail: "high" },
      ],
    }),
    "run1",
  );
  const e = events[0]!;
  if (e.type !== "tool_call_finished") {
    throw new Error("expected tool_call_finished");
  }
  assert.deepEqual(e.images, [
    { mimeType: "image/png", data: "abc", bytes: 3 },
    { mimeType: "image/jpeg", data: "def", bytes: 3, detail: "high" },
  ]);
});

test("tool_result: text-only output omits images field entirely", () => {
  const events = mapAgentEvent(makeToolResult({ content: [{ type: "text", text: "ok" }] }), "run1");
  const e = events[0]!;
  if (e.type !== "tool_call_finished") {
    throw new Error("expected tool_call_finished");
  }
  assert.equal(e.images, undefined);
});

test("tool_result: preserves toolName", () => {
  const events = mapAgentEvent(
    makeToolResult({ toolName: "read_file" }),
    "run1",
  );
  if (events[0]!.type === "tool_call_finished") {
    assert.equal(events[0]!.toolName, "read_file");
  }
});

test("tool_result: lineCount across multiple blocks", () => {
  const events = mapAgentEvent(
    makeToolResult({
      content: [
        { type: "text", text: "a\nb" },
        { type: "text", text: "c\nd\ne" },
      ],
    }),
    "run1",
  );
  const e = events[0]!;
  if (e.type !== "tool_call_finished") return;
  assert.equal(e.resultLineCount, 5);
});

test("tool_results_projected: maps tool_result to detail_available with fullText", () => {
  const events = mapAgentEvent(
    {
      type: "tool_results_projected",
      sessionId: "s1",
      turnId: "t1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc1",
            content: [{ type: "text", text: "full output here" }],
          },
        ],
      },
    } as AgentEvent,
    "run1",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "tool_result_detail_available");
  if (events[0]!.type === "tool_result_detail_available") {
    assert.equal(events[0]!.toolCallId, "tc1");
    assert.equal(events[0]!.fullText, "full output here");
    assert.equal(events[0]!.resultPath, undefined);
  }
});

test("tool_results_projected: maps tool_result_reference to detail_available with path", () => {
  const events = mapAgentEvent(
    {
      type: "tool_results_projected",
      sessionId: "s1",
      turnId: "t1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result_reference",
            toolCallId: "tc2",
            path: "/tmp/tc2.txt",
            originalBytes: 100000,
            preview: "head...",
            hasMore: true,
          },
        ],
      },
    } as AgentEvent,
    "run1",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "tool_result_detail_available");
  if (events[0]!.type === "tool_result_detail_available") {
    assert.equal(events[0]!.toolCallId, "tc2");
    assert.equal(events[0]!.resultPath, "/tmp/tc2.txt");
    assert.equal(events[0]!.fullText, undefined);
  }
});

test("subagent_status maps to agent_status detail", () => {
  const events = mapAgentEvent(
    {
      type: "subagent_status",
      sessionId: "s1",
      turnId: "t1",
      subagentId: "sub-1",
      subagentType: "explore",
      status: "tool_started",
      toolCallId: "child-read",
      toolName: "read_file",
      durationMs: 1200,
    } as AgentEvent,
    "run1",
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "agent_status",
    event: "subagent_status",
    detail: {
      subagentId: "sub-1",
      subagentType: "explore",
      status: "tool_started",
      toolCallId: "child-read",
      toolName: "read_file",
      success: undefined,
      durationMs: 1200,
    },
  });
});

test("subagent_model_event text delta maps to subagent_text_delta status", () => {
  const events = mapAgentEvent(
    {
      type: "subagent_model_event",
      sessionId: "s1",
      turnId: "t1",
      subagentId: "sub-1",
      subagentType: "explore",
      event: { type: "text_delta", text: "drafting plan" },
    } as AgentEvent,
    "run1",
  );

  assert.deepEqual(events, [{
    type: "agent_status",
    event: "subagent_text_delta",
    detail: {
      subagentId: "sub-1",
      subagentType: "explore",
      text: "drafting plan",
    },
  }]);
});

test("subagent tool call and result map to visible activity statuses", () => {
  const started = mapAgentEvent(
    {
      type: "subagent_tool_calls_detected",
      sessionId: "s1",
      turnId: "t1",
      subagentId: "sub-1",
      subagentType: "general-purpose",
      calls: [{ id: "tc1", name: "edit_file", input: { file_path: "game.html", new_string: "html" } }],
    } as AgentEvent,
    "run1",
  );

  assert.deepEqual(started, [{
    type: "agent_status",
    event: "subagent_tool_call_started",
    detail: {
      subagentId: "sub-1",
      subagentType: "general-purpose",
      toolCallId: "tc1",
      toolName: "edit_file",
      input: { file_path: "game.html", new_string: "html" },
    },
  }]);

  const finished = mapAgentEvent(
    {
      type: "subagent_tool_result",
      sessionId: "s1",
      turnId: "t1",
      subagentId: "sub-1",
      subagentType: "general-purpose",
      result: {
        type: "success",
        toolCallId: "tc1",
        toolName: "edit_file",
        content: [{ type: "text", text: "wrote game.html" }],
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    } as AgentEvent,
    "run1",
  );

  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.type, "agent_status");
  if (finished[0]?.type === "agent_status") {
    assert.equal(finished[0].event, "subagent_tool_result");
    assert.equal(finished[0].detail?.toolName, "edit_file");
    assert.equal(finished[0].detail?.ok, true);
    assert.equal(finished[0].detail?.preview, "wrote game.html");
  }
});
