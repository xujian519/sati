import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROTOCOL_METHOD_VERSION,
  PROTOCOL_RELEASES,
  SATI_GATEWAY_PROTOCOL_VERSION,
  isProtocolCompatible,
  protocolLedgerIssues,
  type ProtocolLedgerInput,
  type ProtocolLedgerIssueCode,
} from "../../src/gateway/protocol/version.js";
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

/**
 * `protocolLedgerIssues` 的畸形台账用例。
 *
 * 刻意**逐条独立成 it** 而非在一个 it 里循环：循环遇到首个失败即中止，负控制时
 * 只能看到一条红，无法逐条核对「红在预期的那一处」。
 */
const LEDGER_ISSUE_CASES: ReadonlyArray<{
  name: string;
  input: ProtocolLedgerInput;
  codes: ProtocolLedgerIssueCode[];
}> = [
  {
    name: "台账为空",
    input: { releases: [], methodVersions: {}, currentVersion: "1.0" },
    codes: ["version-gap"],
  },
  {
    name: "首条不是 1.0 基线",
    input: { releases: [{ version: "1.1", changes: ["x"] }], methodVersions: {}, currentVersion: "1.1" },
    codes: ["version-gap"],
  },
  {
    name: "版本号不是 MAJOR.MINOR",
    input: { releases: [{ version: "1.x", changes: ["x"] }], methodVersions: {}, currentVersion: "1.x" },
    codes: ["version-malformed"],
  },
  {
    name: "版本号重复且回退",
    input: {
      releases: [
        { version: "1.0", changes: ["x"] },
        { version: "1.1", changes: ["y"] },
        { version: "1.0", changes: ["z"] },
      ],
      methodVersions: {},
      currentVersion: "1.0",
    },
    codes: ["version-duplicate", "version-not-ascending"],
  },
  {
    name: "版本序列空洞",
    input: {
      releases: [
        { version: "1.0", changes: ["x"] },
        { version: "1.2", changes: ["y"] },
      ],
      methodVersions: {},
      currentVersion: "1.2",
    },
    codes: ["version-gap"],
  },
  {
    name: "MINOR 既无方法登记也无 changes 说明",
    input: {
      releases: [{ version: "1.0", changes: ["x"] }, { version: "1.1" }],
      methodVersions: {},
      currentVersion: "1.1",
    },
    codes: ["release-without-credit"],
  },
  {
    name: "方法登记在台账未声明的版本",
    input: {
      releases: [{ version: "1.0", changes: ["x"] }],
      methodVersions: { some_method: "9.9" },
      currentVersion: "1.0",
    },
    codes: ["method-version-unknown"],
  },
  {
    name: "常量与台账末条不一致",
    input: {
      releases: [
        { version: "1.0", changes: ["x"] },
        { version: "1.1", changes: ["y"] },
      ],
      methodVersions: {},
      currentVersion: "1.2",
    },
    codes: ["current-not-latest"],
  },
];

describe("协议版本台账（version.ts）", () => {
  it("自洽：版本严格升序连续、版本与方法互相 credit、常量等于台账末条", () => {
    assert.deepEqual(
      protocolLedgerIssues({
        releases: PROTOCOL_RELEASES,
        methodVersions: PROTOCOL_METHOD_VERSION,
        currentVersion: SATI_GATEWAY_PROTOCOL_VERSION,
      }),
      [],
    );
  });

  it("当前协议版本钉在 1.9（bump 须同时追加一条 PROTOCOL_RELEASES）", () => {
    assert.equal(SATI_GATEWAY_PROTOCOL_VERSION, "1.9");
  });

  it("回归：两处长期漏登记的方法各自钉在真实引入版本（#362）", () => {
    // knowledge_capabilities：2026-08-06 进入 frames.ts，当时版本常量已是 1.1；
    // kanban_reorder_columns：2026-08-26 随 Phase 5.1「列拖拽排序」进入，当时常量已是 1.5。
    // 两者长期未登记，直到 pnpm check:protocol-version 落地时才被点名。
    assert.equal(PROTOCOL_METHOD_VERSION.knowledge_capabilities, "1.1");
    assert.equal(PROTOCOL_METHOD_VERSION.kanban_reorder_columns, "1.5");
  });

  for (const testCase of LEDGER_ISSUE_CASES) {
    it(`protocolLedgerIssues 逐类点名：${testCase.name}`, () => {
      assert.deepEqual(
        protocolLedgerIssues(testCase.input).map(issue => issue.code),
        testCase.codes,
      );
    });
  }
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
