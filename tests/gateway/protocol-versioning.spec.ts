import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProtocolCompatible, SATI_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../src/gateway/server/GatewayWsConnection.js";
import { TextWebSocketConnection } from "../../src/gateway/server/websocket.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";

describe("isProtocolCompatible", () => {
  it("同 MAJOR（含低 MINOR 的 Web 客户端 1.0）兼容", () => {
    assert.equal(isProtocolCompatible("1.0", "1.1"), true);
    assert.equal(isProtocolCompatible("1.1", "1.1"), true);
    assert.equal(isProtocolCompatible("1.9", "1.0"), true);
  });

  it("不同 MAJOR 不兼容", () => {
    assert.equal(isProtocolCompatible("2.0", "1.1"), false);
    assert.equal(isProtocolCompatible("0.9", "1.0"), false);
  });

  it("空版本不兼容", () => {
    assert.equal(isProtocolCompatible("", "1.1"), false);
    assert.equal(isProtocolCompatible("1.1", ""), false);
  });
});

describe("GatewayWsConnection hello 协商", () => {
  class MockWs {
    sent: string[] = [];
    closeCode: number | undefined;
    closeReason: string | undefined;
    private handler?: (message: string) => void;

    onMessage(handler: (message: string) => void): void {
      this.handler = handler;
    }
    onClose(_handler: () => void): void {}
    sendText(message: string): void {
      this.sent.push(message);
    }
    close(code?: number, reason?: string): void {
      this.closeCode = code;
      this.closeReason = reason;
    }
    receive(raw: string): void {
      this.handler?.(raw);
    }
  }

  function makeConnection(mockWs: MockWs, token = "test-token"): GatewayWsConnection {
    const gateway = {
      describeServer: async () => ({ protocolVersion: SATI_GATEWAY_PROTOCOL_VERSION, version: "test" }),
    } as unknown as Gateway;
    return new GatewayWsConnection(mockWs as unknown as TextWebSocketConnection, {
      gateway,
      token,
      serverVersion: "test",
    });
  }

  function helloFrame(protocolVersion: string, token = "test-token"): string {
    return JSON.stringify({
      type: "hello",
      protocolVersion,
      clientName: "web",
      clientVersion: "0.1.0",
      token,
    });
  }

  async function settle(): Promise<void> {
    // handleMessage 是 async（内部 await describeServer），mock 的 receive 无法等待它
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  it("Web 客户端协议 1.0（同 MAJOR）通过握手", async () => {
    const ws = new MockWs();
    makeConnection(ws);
    ws.receive(helloFrame("1.0"));
    await settle();
    assert.equal(ws.closeCode, undefined);
    const helloOk = ws.sent.find(line => line.includes('"type":"hello_ok"'));
    assert.ok(helloOk, "应收到 hello_ok");
  });

  it("Node 客户端协议 1.1（当前版本）通过握手", async () => {
    const ws = new MockWs();
    makeConnection(ws);
    ws.receive(helloFrame(SATI_GATEWAY_PROTOCOL_VERSION));
    await settle();
    assert.equal(ws.closeCode, undefined);
  });

  it("MAJOR 不匹配（2.0）拒绝连接", async () => {
    const ws = new MockWs();
    makeConnection(ws);
    ws.receive(helloFrame("2.0"));
    await settle();
    assert.equal(ws.closeCode, 4001);
    assert.equal(ws.closeReason, "protocol_mismatch");
  });

  it("token 错误拒绝连接", async () => {
    const ws = new MockWs();
    makeConnection(ws);
    ws.receive(helloFrame("1.0", "wrong-token"));
    await settle();
    assert.equal(ws.closeCode, 4003);
    assert.equal(ws.closeReason, "auth_failed");
  });
});
