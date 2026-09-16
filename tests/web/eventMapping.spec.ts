import test from "node:test";
import assert from "node:assert/strict";
import { mapGatewayEventToFrames } from "../../src/web/client/eventMapping.js";

test("tool_call_finished 透传结构化 data 为 payload（document_style_panel）", () => {
  const frames = mapGatewayEventToFrames(
    {
      type: "tool_call_finished",
      toolCallId: "call-panel",
      toolName: "document_style_panel",
      ok: true,
      resultPreview: "已打开文书排版调参面板：/w/docs/out.html",
      data: {
        kind: "document_style_panel",
        htmlPath: "/w/docs/out.html",
        style: { fontSize: { base: "14pt" } },
      },
    },
    "s1",
  );

  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.equal(frame?.kind, "tool_result");
  assert.equal(frame?.toolId, "call-panel");
  assert.deepEqual(frame?.payload, {
    kind: "document_style_panel",
    htmlPath: "/w/docs/out.html",
    style: { fontSize: { base: "14pt" } },
  });
});

test("tool_call_finished 无 data 时不产生 payload 字段", () => {
  const frames = mapGatewayEventToFrames(
    {
      type: "tool_call_finished",
      toolCallId: "call-plain",
      toolName: "bash",
      ok: true,
      resultPreview: "ok",
    },
    "s1",
  );

  assert.equal(frames.length, 1);
  assert.equal("payload" in frames[0]!, false);
});

test("compact_completed 成功产出压缩边界帧并带终态", () => {
  const frames = mapGatewayEventToFrames(
    {
      type: "agent_status",
      event: "compact_completed",
      detail: { compactionId: "compact-ok", trigger: "auto", status: "success", preTokens: 120, postTokens: 40 },
    },
    "s1",
  );

  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.kind, "compact_boundary");
  assert.equal(frames[0]?.compactState, "success");
});

test("compact_completed 的失败/中断不得产出压缩边界帧（否则显示成「已压缩」）", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const frames = mapGatewayEventToFrames(
      {
        type: "agent_status",
        event: "compact_completed",
        detail: { compactionId: `compact-${status}`, trigger: "auto", status, preTokens: 120 },
      },
      "s1",
    );

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.kind, "status", `${status} 不得渲染成压缩边界行`);
    const progress = frames[0]?.compactProgress as { state?: string; compaction_id?: string } | undefined;
    assert.equal(progress?.state, status);
    assert.equal(progress?.compaction_id, `compact-${status}`);
  }
});
