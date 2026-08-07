import { describe, expect, it } from "vitest";
import { mapOutgoingMessage } from "./gatewayChatMapper";
import type { GatewayCall } from "./gatewayChatMapper";

describe("mapOutgoingMessage: sati-command", () => {
  it("带 sessionId → submit_turn", () => {
    const call = mapOutgoingMessage({
      type: "sati-command",
      command: "继续",
      options: { sessionId: "s1", projectPath: "/abs/p", runMode: "agent", permissionMode: "default" },
    }) as Extract<GatewayCall, { kind: "submit_turn" }>;
    expect(call.kind).toBe("submit_turn");
    expect(call.input).toMatchObject({
      sessionKey: "s1",
      channelKey: "web",
      message: "继续",
      projectKey: "/abs/p",
      runMode: "agent",
      mode: "default",
    });
  });

  it("无 sessionId → new_session_then_submit", () => {
    const call = mapOutgoingMessage({
      type: "sati-command",
      command: "帮我写专利",
      options: { projectPath: "/abs/p" },
    }) as Extract<GatewayCall, { kind: "new_session_then_submit" }>;
    expect(call.kind).toBe("new_session_then_submit");
    expect(call.newSession).toMatchObject({ projectKey: "/abs/p", channelKey: "web", hint: "帮我写专利" });
    expect(call.submit.sessionKey).toBe("");
  });

  it("images → attachments（WebChannelAttachment）", () => {
    const call = mapOutgoingMessage({
      type: "sati-command",
      command: "看图",
      options: { sessionId: "s1", images: [{ mimeType: "image/png", data: "AA==" }] },
    }) as Extract<GatewayCall, { kind: "submit_turn" }>;
    expect(call.input.attachments).toEqual([{ type: "image", mimeType: "image/png", data: "AA==" }]);
  });
});

describe("mapOutgoingMessage: 其他帧", () => {
  it("abort-session → abort_turn", () => {
    const call = mapOutgoingMessage({ type: "abort-session", sessionId: "s1", provider: "sati" });
    expect(call).toEqual({ kind: "abort_turn", input: { sessionKey: "s1" } });
  });

  it("abort-session 缺 sessionId → ignore", () => {
    expect(mapOutgoingMessage({ type: "abort-session" })).toEqual({ kind: "ignore" });
  });

  it("permission-response → permission_decide（含 remember/reason）", () => {
    const call = mapOutgoingMessage({
      type: "permission-response",
      requestId: "req-1",
      sessionId: "s1",
      allow: true,
      rememberEntry: true,
      message: "trusted",
    });
    expect(call).toEqual({
      kind: "permission_decide",
      input: { sessionKey: "s1", requestId: "req-1", decision: "allow", remember: true, reason: "trusted" },
    });
  });

  it("permission-response 拒绝：decision=deny", () => {
    const call = mapOutgoingMessage({ type: "permission-response", requestId: "req-2", sessionId: "s1", allow: false });
    expect(call).toMatchObject({ kind: "permission_decide", input: { decision: "deny" } });
  });

  it("elicitation-response → elicitation_respond", () => {
    const call = mapOutgoingMessage({
      type: "elicitation-response",
      requestId: "req-3",
      sessionId: "s1",
      answer: { q1: "A" },
    });
    expect(call).toEqual({
      kind: "elicitation_respond",
      input: { sessionKey: "s1", requestId: "req-3", answer: { q1: "A" } },
    });
  });

  it("未知帧 → non_chat（非聊天协议帧，由调用方路由到事件通道）", () => {
    expect(mapOutgoingMessage({ type: "watch-session", sessionId: "s1" })).toEqual({ kind: "non_chat" });
    expect(mapOutgoingMessage({ type: "ping" })).toEqual({ kind: "non_chat" });
  });

  it("permission-response 缺字段 → ignore", () => {
    expect(mapOutgoingMessage({ type: "permission-response", requestId: "x" })).toEqual({ kind: "ignore" });
  });
});
