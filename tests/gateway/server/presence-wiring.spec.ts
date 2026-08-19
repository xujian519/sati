import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SATI_GATEWAY_PROTOCOL_VERSION } from "../../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../../src/gateway/server/GatewayWsConnection.js";
import { TextWebSocketConnection } from "../../../src/gateway/server/websocket.js";
import { SessionPresence } from "../../../src/gateway/server/sessionPresence.js";
import type { Gateway } from "../../../src/gateway/protocol/types.js";

/**
 * M3 接线测试：GatewayWsConnection 帧级 presence touch / onClose close。
 * 基建同 tests/gateway/protocol-versioning.spec.ts 的 MockWs 直构，
 * 增强点：捕获 onClose 回调（emitClose 触发）、sendBatch（submit_turn 事件流路径）。
 */
describe("GatewayWsConnection presence 接线（M3）", () => {
  class MockWs {
    sent: string[] = [];
    closeCode: number | undefined;
    closeReason: string | undefined;
    private messageHandler?: (message: string) => void;
    private closeHandlers: Array<() => void> = [];

    onMessage(handler: (message: string) => void): void {
      this.messageHandler = handler;
    }
    onClose(handler: () => void): void {
      this.closeHandlers.push(handler);
    }
    sendText(message: string): void {
      this.sent.push(message);
    }
    sendBatch(messages: string[]): void {
      this.sent.push(...messages);
    }
    close(code?: number, reason?: string): void {
      this.closeCode = code;
      this.closeReason = reason;
    }
    receive(raw: string): void {
      this.messageHandler?.(raw);
    }
    emitClose(): void {
      for (const handler of this.closeHandlers) handler();
    }
  }

  /** 记录 touch/close 调用的 spy presence（透传真实实现，语义与生产一致）。 */
  class RecordingPresence extends SessionPresence {
    touched: string[] = [];
    closed: string[] = [];
    override touch(sessionKey: string, now: number = Date.now()): void {
      this.touched.push(sessionKey);
      super.touch(sessionKey, now);
    }
    override close(sessionKey: string, now: number = Date.now()): void {
      this.closed.push(sessionKey);
      super.close(sessionKey, now);
    }
  }

  function makeConnection(mockWs: MockWs, presence?: SessionPresence): GatewayWsConnection {
    const gateway = {
      describeServer: async () => ({ protocolVersion: SATI_GATEWAY_PROTOCOL_VERSION, version: "test" }),
      submitTurn: async function* () {
        yield { type: "turn_completed", usage: {}, finishReason: "completed" };
      },
    } as unknown as Gateway;
    return new GatewayWsConnection(mockWs as unknown as TextWebSocketConnection, {
      gateway,
      token: "test-token",
      serverVersion: "test",
      presence,
    });
  }

  function helloFrame(protocolVersion: string): string {
    return JSON.stringify({
      type: "hello",
      protocolVersion,
      clientName: "web",
      clientVersion: "0.1.0",
      token: "test-token",
    });
  }

  function submitFrame(sessionKey?: string): string {
    return JSON.stringify({
      type: "request",
      id: "1",
      method: "submit_turn",
      params: sessionKey === undefined ? {} : { sessionKey },
    });
  }

  async function settle(): Promise<void> {
    // handleMessage 是 async，mock 的 receive 无法等待它（同 protocol-versioning.spec.ts）
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  it("请求帧（submit_turn）带 sessionKey → presence.touch(sessionKey) 被调用", async () => {
    const ws = new MockWs();
    const presence = new RecordingPresence();
    makeConnection(ws, presence);
    ws.receive(helloFrame("1.0"));
    await settle();
    ws.receive(submitFrame("s1"));
    await settle();
    assert.deepEqual(presence.touched, ["s1"]);
    // 函数级变量未破坏 submit_turn 分支：事件流照常完成
    assert.ok(
      ws.sent.some(line => line.includes('"final":true')),
      "submit_turn 分支应正常产出 final 帧",
    );
  });

  it("非 submit_turn 请求帧（describe_server）带 sessionKey 同样 touch（不只 submit_turn）", async () => {
    const ws = new MockWs();
    const presence = new RecordingPresence();
    makeConnection(ws, presence);
    ws.receive(helloFrame("1.0"));
    await settle();
    ws.receive(JSON.stringify({ type: "request", id: "1", method: "describe_server", params: { sessionKey: "s2" } }));
    await settle();
    assert.deepEqual(presence.touched, ["s2"]);
  });

  it("ws close → presence.close(lastSessionKey) 被调用；重复 close 事件幂等", async () => {
    const ws = new MockWs();
    const presence = new RecordingPresence();
    makeConnection(ws, presence);
    ws.receive(helloFrame("1.0"));
    await settle();
    ws.receive(submitFrame("s1"));
    await settle();
    ws.emitClose();
    ws.emitClose();
    assert.deepEqual(presence.closed, ["s1", "s1"], "每次 close 事件都以最近 sessionKey 注销");
    // 底层幂等：close 不后移 closedAt（超窗判定以首次 close 计，见 sessionPresence.spec.ts L48）
    assert.equal(presence.isActive("s1"), true, "宽限窗内仍在线");
  });

  it("无 sessionKey 的请求帧 → 不调用 touch；关闭也不注销", async () => {
    const ws = new MockWs();
    const presence = new RecordingPresence();
    makeConnection(ws, presence);
    ws.receive(helloFrame("1.0"));
    await settle();
    ws.receive(submitFrame());
    await settle();
    assert.deepEqual(presence.touched, []);
    ws.emitClose();
    assert.deepEqual(presence.closed, [], "lastSessionKey 未设置时不触发 close");
  });

  it("presence 未注入（undefined）→ 构造/收帧/关闭全链路不崩溃", async () => {
    const ws = new MockWs();
    makeConnection(ws, undefined);
    ws.receive(helloFrame("1.0"));
    await settle();
    ws.receive(submitFrame("s1"));
    await settle();
    ws.emitClose();
    assert.ok(
      ws.sent.some(line => line.includes('"type":"hello_ok"')),
      "hello 握手正常",
    );
    assert.ok(
      ws.sent.some(line => line.includes('"final":true')),
      "submit_turn 正常完成",
    );
  });
});
