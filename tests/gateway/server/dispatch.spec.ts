import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SATI_GATEWAY_PROTOCOL_VERSION } from "../../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../../src/gateway/server/GatewayWsConnection.js";
import { TextWebSocketConnection } from "../../../src/gateway/server/websocket.js";
import type { Gateway } from "../../../src/gateway/protocol/types.js";

/**
 * dispatchRequest 分发回归（类型断言替换：`as never` → `as GatewayMethodParams<"...">`）。
 * cast 变更本身运行时等价，本测试锁定分发边界契约，防未来重构破坏：
 *   - 具名输入类型方法路由透传 params 并回 `{ok:true, result}`；
 *   - 内联对象类型方法路由统一为 `{ok:true}`；
 *   - 可选方法未接线 → `not_configured` 降级结果；
 *   - 未知方法 → `gateway_request_failed` 失败帧；
 *   - SkillManagerError（结构化）回码/信息返回客户端。
 */
describe("GatewayWsConnection dispatchRequest 分发路由", () => {
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

  /** 最小可用 gateway：`describeServer` 为 hello 握手必需，其余按需 spread。 */
  function baseGateway(): Gateway {
    return {
      describeServer: async () => ({ protocolVersion: SATI_GATEWAY_PROTOCOL_VERSION, version: "test" }),
    } as unknown as Gateway;
  }

  function makeConnection(mockWs: MockWs, gateway: Gateway): GatewayWsConnection {
    return new GatewayWsConnection(mockWs as unknown as TextWebSocketConnection, {
      gateway,
      token: "test-token",
      serverVersion: "test",
      presence: undefined,
    });
  }

  function helloFrame(): string {
    return JSON.stringify({
      type: "hello",
      protocolVersion: "1.0",
      clientName: "web",
      clientVersion: "0.1.0",
      token: "test-token",
    });
  }

  function requestFrame(id: string, method: string, params?: unknown): string {
    return JSON.stringify({ type: "request", id, method, params });
  }

  function invalidParamsErrorFrame(ws: MockWs): { code?: string; message?: string } {
    const line = ws.sent.find(l => l.includes('"ok":false') && l.includes("invalid_params"));
    return line ? (JSON.parse(line).error as { code?: string; message?: string }) : {};
  }

  it("守卫表：畸形入参（kanban_get 缺 projectKey）→ invalid_params，不深入实现层", async () => {
    const ws = new MockWs();
    // gateway 不实现任何 kanban 方法：若守卫失效，分发将走 not_configured，
    // 该用例以「收到的是 invalid_params 而非 not_configured」锁死边界行为。
    makeConnection(ws, baseGateway());
    ws.receive(helloFrame());
    await settle();
    ws.receive(requestFrame("1", "kanban_get", {}));
    await settle();
    const err = invalidParamsErrorFrame(ws);
    assert.equal(err.code, "invalid_params");
    assert.match(err.message ?? "", /projectKey/);
  });

  it("守卫表：字段类型错误（submit_turn.sessionKey 非字符串）→ invalid_params", async () => {
    const ws = new MockWs();
    let submitCalled = false;
    const gateway = {
      ...baseGateway(),
      submitTurn: async function* () {
        submitCalled = true;
        yield { type: "turn_completed", usage: {}, finishReason: "completed" };
      },
    } as unknown as Gateway;
    makeConnection(ws, gateway);
    ws.receive(helloFrame());
    await settle();
    ws.receive(requestFrame("1", "submit_turn", { sessionKey: 42, channelKey: "cli", message: "hi" }));
    await settle();
    assert.equal(invalidParamsErrorFrame(ws).code, "invalid_params");
    assert.ok(!submitCalled, "守卫拒绝后不得进入 gateway.submitTurn");
  });

  async function settle(): Promise<void> {
    // handleMessage 异步，mock 的 receive 无法等待它（同 presence-wiring.spec.ts）
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  it("具名输入类型方法（list_sessions）把 params 透传 gateway 并回 {ok:true,result}", async () => {
    const ws = new MockWs();
    const gateway = {
      ...baseGateway(),
      listSessions: async (input: { projectKey?: string }) => ({ sessions: [input.projectKey ?? "s1"] }),
    } as unknown as Gateway;
    makeConnection(ws, gateway);
    ws.receive(helloFrame());
    await settle();
    ws.receive(requestFrame("1", "list_sessions", { projectKey: "p1" }));
    await settle();
    assert.ok(
      ws.sent.some(
        line => line.includes('"type":"response"') && line.includes('"ok":true') && line.includes('"sessions":["p1"]'),
      ),
      "list_sessions 应回路由结果帧",
    );
  });

  it("内联对象类型方法（abort_turn）返回值统一成 {ok:true}", async () => {
    const ws = new MockWs();
    const gateway = {
      ...baseGateway(),
      abortTurn: async () => undefined,
    } as unknown as Gateway;
    makeConnection(ws, gateway);
    ws.receive(helloFrame());
    await settle();
    ws.receive(requestFrame("1", "abort_turn", { sessionKey: "s1" }));
    await settle();
    assert.ok(
      ws.sent.some(
        line =>
          line.includes('"type":"response"') && line.includes('"ok":true') && line.includes('"result":{"ok":true}'),
      ),
      "abort_turn 应回 {ok:true} 结果帧",
    );
  });

  it("可选方法未接线（always_on_apply 缺省）→ not_configured 降级结果，不崩溃", async () => {
    const ws = new MockWs();
    makeConnection(ws, baseGateway());
    ws.receive(helloFrame());
    await settle();
    ws.receive(requestFrame("1", "always_on_apply", { sessionKey: "s1" }));
    await settle();
    assert.ok(
      ws.sent.some(
        line =>
          line.includes('"type":"response"') && line.includes('"ok":true') && line.includes('"code":"not_configured"'),
      ),
      "未接线可选方法应回 not_configured 降级结果帧",
    );
  });

  it("未知方法 → gateway_request_failed 失败帧（含 Unknown gateway method）", async () => {
    const ws = new MockWs();
    makeConnection(ws, baseGateway());
    ws.receive(helloFrame());
    await settle();
    ws.receive(requestFrame("1", "bogus_method", {}));
    await settle();
    assert.ok(
      ws.sent.some(
        line =>
          line.includes('"type":"response"') &&
          line.includes('"ok":false') &&
          line.includes('"code":"gateway_request_failed"') &&
          line.includes("Unknown gateway method"),
      ),
      "未知方法应回 gateway_request_failed 失败帧",
    );
  });

  it("SkillManagerError（结构化）→ 错误码/信息往返客户端", async () => {
    const ws = new MockWs();
    makeConnection(ws, baseGateway()); // skillRead 未接线 → requireSkillMethod 抛 SkillManagerError
    ws.receive(helloFrame());
    await settle();
    ws.receive(requestFrame("1", "skill_read", { slug: "foo" }));
    await settle();
    assert.ok(
      ws.sent.some(
        line =>
          line.includes('"type":"response"') &&
          line.includes('"ok":false') &&
          line.includes('"code":"not_configured"') &&
          line.includes("Skill management is not enabled"),
      ),
      "SkillManagerError 应回结构化错误帧",
    );
  });
});
