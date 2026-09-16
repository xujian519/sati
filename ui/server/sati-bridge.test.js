// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildActiveTurnMessages,
  gatewayEventToFrames,
  getFallbackSessionActivity,
  isGatewayUnavailableError,
} from "./sati-bridge.js";

describe("session activity fallback", () => {
  it("reports unknown while preserving a locally known run id", () => {
    expect(getFallbackSessionActivity({ active: true, runId: "run-local" })).toEqual({
      isProcessing: null,
      activeRunId: "run-local",
      activeTurnMessages: [],
    });
  });

  it("reports unknown instead of false when local state cannot prove inactivity", () => {
    expect(getFallbackSessionActivity(undefined)).toEqual({
      isProcessing: null,
      activeRunId: null,
      activeTurnMessages: [],
    });
    expect(getFallbackSessionActivity({ active: false, runId: undefined })).toEqual({
      isProcessing: null,
      activeRunId: null,
      activeTurnMessages: [],
    });
  });
});

describe("gatewayEventToFrames agent status errors", () => {
  it("maps tool result detail availability to a mergeable tool_result frame", () => {
    const frames = gatewayEventToFrames(
      {
        type: "tool_result_detail_available",
        toolCallId: "call-large",
        resultPath: "/tmp/sati/tool-result.txt",
        fullText: "x".repeat(100000),
      },
      "web:s_test",
      "sati",
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "tool_result",
      toolId: "call-large",
      content: "Full tool result persisted at /tmp/sati/tool-result.txt",
      resultPath: "/tmp/sati/tool-result.txt",
    });
    expect(frames[0].fullText).toBeUndefined();
  });

  it("bounds live tool result previews before they reach React state", () => {
    const frames = gatewayEventToFrames(
      {
        type: "tool_call_finished",
        toolCallId: "call-large",
        ok: true,
        resultPreview: `head\n${"x".repeat(50000)}\ntail`,
      },
      "web:s_test",
      "sati",
    );

    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("tool_result");
    expect(frames[0].content.length).toBeLessThan(22000);
    expect(frames[0].content).toContain("UI preview truncated");
    expect(frames[0].content).toContain("head");
    expect(frames[0].content).toContain("tail");
  });

  it("uses detail.userHint for model_empty_response_exhausted", () => {
    const frames = gatewayEventToFrames(
      {
        type: "agent_status",
        event: "model_empty_response_exhausted",
        detail: {
          message: "The model returned empty content repeatedly.",
          userHint: "Increase max output tokens.",
          visible: true,
        },
      },
      "web:s_test",
      "sati",
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "error",
      content: "The model returned empty content repeatedly.",
      code: "model_empty_response_exhausted",
      userHint: "Increase max output tokens.",
    });
  });

  it("renders new semantic status events as error frames", () => {
    const frames = gatewayEventToFrames(
      {
        type: "agent_status",
        event: "model_request_failed",
        detail: {
          message: "Provider rejected the request.",
          messageI18n: {
            key: "chat:agentStatus.modelRequestFailed.message",
            params: { providerMessage: "Provider rejected the request." },
          },
          userHint: "Check provider settings.",
          userHintI18n: { key: "chat:agentStatus.modelRequestFailed.actions.settingsDefault" },
          visible: true,
        },
      },
      "web:s_test",
      "sati",
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "error",
      content: "Provider rejected the request.",
      contentI18n: {
        key: "chat:agentStatus.modelRequestFailed.message",
        params: { providerMessage: "Provider rejected the request." },
      },
      code: "model_request_failed",
      userHint: "Check provider settings.",
      userHintI18n: { key: "chat:agentStatus.modelRequestFailed.actions.settingsDefault" },
    });
  });

  it("renders bridge visible failure status events as error frames", () => {
    const frames = gatewayEventToFrames(
      {
        type: "agent_status",
        event: "gateway_bridge_error",
        detail: {
          message: "Bridge crashed while streaming.",
          code: "gateway_bridge_error",
          severity: "error",
          visible: true,
          userHint: "Check UI server logs.",
          scope: "turn",
          source: "web_bridge",
        },
      },
      "web:s_test",
      "sati",
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "error",
      content: "Bridge crashed while streaming.",
      code: "gateway_bridge_error",
      userHint: "Check UI server logs.",
    });
  });

  it("carries post-compact token budget on compact boundary frames", () => {
    const frames = gatewayEventToFrames(
      {
        type: "agent_status",
        event: "compact_completed",
        detail: {
          preTokens: 76000,
          postTokens: 12000,
          messagesSummarized: 8,
          tokenBudget: {
            used: 12000,
            displayUsed: 12000,
            budgetUsed: 12000,
            total: 100000,
            effectiveTotal: 90000,
            state: "ok",
            source: "compact",
          },
        },
      },
      "web:s_test",
      "sati",
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "compact_boundary",
      postTokens: 12000,
      tokenBudget: {
        used: 12000,
        total: 100000,
        state: "ok",
        source: "compact",
      },
    });
  });

  it("renders gateway unavailable preflight status as an error frame", () => {
    const frames = gatewayEventToFrames(
      {
        type: "agent_status",
        event: "gateway_unavailable",
        detail: {
          message: "Sati gateway is unavailable.",
          code: "gateway_unavailable",
          severity: "error",
          visible: true,
          userHint: "Start or restart the Sati gateway, then retry this message.",
          scope: "preflight",
          source: "web_bridge",
        },
      },
      "web:s_test",
      "sati",
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "error",
      content: "Sati gateway is unavailable.",
      code: "gateway_unavailable",
      userHint: "Start or restart the Sati gateway, then retry this message.",
    });
  });
});

describe("buildActiveTurnMessages（协议 1.9 绝对投影）", () => {
  const sessionId = "web:s_projection";

  function snapshotWith(events, blocks, runId = "run-1") {
    return { active: true, sessionKey: sessionId, runId, events, ...(blocks ? { projection: { runId, blocks } } : {}) };
  }

  it("投影帧携带完整全文，delta 帧同时保留（旧网关靠它兜底）", () => {
    // 事件日志只剩截断后的尾部（开头已丢），投影是全文
    const events = [
      { type: "assistant_text_delta", runId: "run-1", text: "后半段" },
      { type: "tool_call_started", runId: "run-1", toolCallId: "c1", name: "read_file" },
    ];
    const blocks = [{ kind: "text", epoch: 1, text: "开头也在的全文后半段", inflight: true }];

    const frames = buildActiveTurnMessages(snapshotWith(events, blocks), sessionId, "sati");

    const textFrames = frames.filter(frame => frame.activeTurnProjection === true);
    expect(textFrames).toHaveLength(1);
    expect(textFrames[0]).toMatchObject({
      kind: "text",
      role: "assistant",
      id: `active-turn:${sessionId}:run-1:text:1`,
      content: "开头也在的全文后半段",
    });
    // delta 不被滤掉：未实现 projection 的对端必须保持原行为
    expect(frames.filter(frame => frame.kind === "stream_delta")).toHaveLength(1);
  });

  it("投影帧插在最后一个正文 delta 的位置（先建行、再覆盖，且在 tool_use finalize 之前）", () => {
    const events = [
      { type: "assistant_text_delta", runId: "run-1", text: "答" },
      { type: "tool_call_started", runId: "run-1", toolCallId: "c1", name: "glob" },
      { type: "assistant_text_delta", runId: "run-1", text: "复" },
      { type: "tool_call_finished", runId: "run-1", toolCallId: "c1", ok: true, resultPreview: "done" },
    ];
    const blocks = [{ kind: "text", epoch: 2, text: "答复", inflight: true }];

    const frames = buildActiveTurnMessages(snapshotWith(events, blocks), sessionId, "sati");
    const kinds = frames.map(frame => (frame.activeTurnProjection === true ? "projection" : frame.kind));

    expect(kinds).toEqual(["stream_delta", "tool_use", "stream_delta", "projection", "tool_result"]);
  });

  it("同一投影重复轮询产出同一 id（幂等锚）", () => {
    const snapshot = snapshotWith(
      [{ type: "assistant_text_delta", runId: "run-1", text: "abc" }],
      [{ kind: "text", epoch: 1, text: "abcdef", inflight: true }],
    );

    const first = buildActiveTurnMessages(snapshot, sessionId, "sati").filter(f => f.activeTurnProjection === true);
    const second = buildActiveTurnMessages(snapshot, sessionId, "sati").filter(f => f.activeTurnProjection === true);

    expect(first[0].id).toBe(second[0].id);
    expect(first[0].content).toBe(second[0].content);
  });

  it("不投影已完成的段，也不投影 thinking", () => {
    const events = [{ type: "assistant_text_delta", runId: "run-1", text: "t" }];
    const blocks = [
      { kind: "text", epoch: 1, text: "上一段" },
      { kind: "thinking", epoch: 1, text: "想", inflight: true },
    ];

    const frames = buildActiveTurnMessages(snapshotWith(events, blocks), sessionId, "sati");

    expect(frames.filter(frame => frame.activeTurnProjection === true)).toHaveLength(0);
    expect(frames.some(frame => frame.kind === "thinking")).toBe(false);
  });

  it("没有投影时行为不变（正文 delta 照常透出）", () => {
    const events = [{ type: "assistant_text_delta", runId: "run-1", text: "abc" }];

    const frames = buildActiveTurnMessages(snapshotWith(events, null), sessionId, "sati");

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "stream_delta", content: "abc" });
  });
});

describe("isGatewayUnavailableError", () => {
  it("detects cached gateway websocket disconnects", () => {
    expect(isGatewayUnavailableError(new Error("Gateway WebSocket is not connected."))).toBe(true);
    expect(isGatewayUnavailableError(new Error("Gateway WebSocket closed."))).toBe(true);
    expect(isGatewayUnavailableError(new Error("Gateway closed during hello: auth_failed"))).toBe(true);
    expect(isGatewayUnavailableError(new Error("[sati-bridge] gateway connect failed after 60000ms"))).toBe(true);
  });

  it("does not classify generic bridge failures as gateway unavailable", () => {
    expect(isGatewayUnavailableError(new Error("Unexpected frame payload"))).toBe(false);
  });
});
