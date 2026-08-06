import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayClient } from "../utils/api";
import { useGatewayDirectChatProviderState } from "./useGatewayDirectChat";

/**
 * 集成测试：直连模式下 sati-command 发送 → submit_turn 流 → 事件归一化 → 广播。
 * 用 mock fetch（token）+ mock WebSocket（自动应答 gateway 协议帧）。
 */

type RequestFrame = { type: "request"; id: string; method: string; params: Record<string, unknown> };

class AutoRespondSocket {
  readyState = 0;
  sent: string[] = [];
  protected handlers: Record<string, Array<(event: { data?: string }) => void>> = {};
  protected opened = false;

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  removeEventListener(): void {}

  send(raw: string): void {
    this.sent.push(raw);
    if (!this.opened) return;
    const frame = JSON.parse(raw) as RequestFrame;
    if (frame.type !== "request") return;
    if (frame.method === "submit_turn") {
      this.replyTurn(frame.id);
    } else if (frame.method === "new_session") {
      this.replyOk(frame.id, { sessionKey: "new-session-1" });
    }
  }
  close(): void {}

  /** 注入服务端帧（message 事件）。 */
  receive(raw: string): void {
    for (const listener of this.handlers.message ?? []) listener({ data: raw });
  }

  /** 模拟意外断线（close 事件）。 */
  crash(code = 1006): void {
    this.readyState = 3;
    for (const listener of this.handlers.close ?? []) listener({ data: String(code), code } as never);
  }

  open(): void {
    this.opened = true;
    this.readyState = 1;
    for (const listener of this.handlers.open ?? []) listener({});
    setTimeout(() => {
      if (this.sent.some(line => line.includes('"type":"hello"'))) {
        for (const listener of this.handlers.message ?? []) {
          listener({
            data: JSON.stringify({ type: "hello_ok", protocolVersion: "1.0", serverVersion: "m", serverInfo: {} }),
          });
        }
      }
    }, 0);
  }

  private replyOk(requestId: string, result: unknown): void {
    for (const listener of this.handlers.message ?? []) {
      listener({ data: JSON.stringify({ type: "response", id: requestId, ok: true, result }) });
    }
  }

  private replyTurn(requestId: string): void {
    // 与 GatewayWsConnection 语义一致：turn_completed 先以真实事件(final:false)发一次，
    // 再用 final:true 合成帧收尾（客户端丢弃 final 帧的事件，只 close 流）。
    for (const listener of this.handlers.message ?? []) {
      listener({
        data: JSON.stringify({
          type: "event",
          id: requestId,
          seq: 0,
          final: false,
          event: { type: "assistant_text_delta", runId: "run-1", text: "你好" },
        }),
      });
      listener({
        data: JSON.stringify({
          type: "event",
          id: requestId,
          seq: 1,
          final: false,
          event: { type: "turn_completed", finishReason: "end_turn", usage: { tokens: 3 } },
        }),
      });
      listener({
        data: JSON.stringify({
          type: "event",
          id: requestId,
          seq: 2,
          final: true,
          event: { type: "turn_completed", finishReason: "end_turn", usage: { tokens: 3 } },
        }),
      });
    }
  }
}

function stubWebSocket(): { sockets: AutoRespondSocket[] } {
  const sockets: AutoRespondSocket[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      readyState = 0;
      constructor() {
        const socket = new AutoRespondSocket();
        sockets.push(socket);
        setTimeout(() => socket.open(), 0);
      }
      addEventListener(...args: Parameters<AutoRespondSocket["addEventListener"]>) {
        sockets[sockets.length - 1].addEventListener(...args);
      }
      removeEventListener() {}
      send(raw: string) {
        sockets[sockets.length - 1].send(raw);
      }
      close() {
        sockets[sockets.length - 1].close();
      }
    },
  );
  return { sockets };
}

describe("断线重连 + 快照恢复（useReconnect 接线）", () => {
  const originalFetch = globalThis.fetch;

  /** submit_turn 挂起（turn 未完成），支持 active_turn_snapshot 应答。 */
  class DisconnectAwareSocket extends AutoRespondSocket {
    override send(raw: string): void {
      this.sent.push(raw);
      if (!this.opened) return;
      const frame = JSON.parse(raw) as RequestFrame;
      if (frame.type !== "request") return;
      if (frame.method === "active_turn_snapshot") {
        // 断线期间新事件（snapshot 全量含已收 + 未收）
        for (const listener of this.handlers.message ?? []) {
          listener({
            data: JSON.stringify({
              type: "response",
              id: frame.id,
              ok: true,
              result: {
                active: true,
                sessionKey: "s1",
                runId: "run-1",
                events: [{ type: "assistant_text_delta", runId: "run-1", text: "断线期间内容" }],
              },
            }),
          });
        }
        return;
      }
      // 其他请求（submit_turn 等）挂起——由测试手动 crash 控制
    }
  }

  function stubDisconnectWebSocket(): { sockets: DisconnectAwareSocket[] } {
    const sockets: DisconnectAwareSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        readyState = 0;
        constructor() {
          const socket = new DisconnectAwareSocket();
          sockets.push(socket);
          setTimeout(() => socket.open(), 0);
        }
        addEventListener(...args: Parameters<DisconnectAwareSocket["addEventListener"]>) {
          sockets[sockets.length - 1].addEventListener(...args);
        }
        removeEventListener() {}
        send(raw: string) {
          sockets[sockets.length - 1].send(raw);
        }
        close() {
          sockets[sockets.length - 1].close();
        }
      },
    );
    return { sockets };
  }

  beforeEach(() => {
    resetGatewayClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/gateway-token") {
          return { ok: true, json: async () => ({ token: "test-token" }) } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("断线 → 自动重连 → snapshot 恢复断线期间事件（无丢失）", async () => {
    const { sockets } = stubDisconnectWebSocket();
    const received: unknown[] = [];
    const { result } = renderHook(() => useGatewayDirectChatProviderState());
    act(() => {
      result.current.subscribe(message => received.push(message));
    });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // 发起 turn（mock 挂起不结束）
    await act(async () => {
      result.current.sendMessage({ type: "sati-command", command: "继续", options: { sessionId: "s1" } });
    });
    expect(result.current.reconnectInfo.status).toBe("connected");

    // 断线
    await act(async () => {
      sockets[0].crash(1006);
    });
    expect(result.current.reconnectInfo.status).toBe("reconnecting");

    // 重连握手（新 socket）
    await act(async () => {
      sockets[1].open();
      await new Promise(resolve => setTimeout(resolve, 0));
      sockets[1].receive(
        JSON.stringify({ type: "hello_ok", protocolVersion: "1.0", serverVersion: "m", serverInfo: {} }),
      );
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    // snapshot 恢复：断线期间事件被重放（无丢失）
    await waitFor(() => {
      const delta = received.find(
        frame =>
          (frame as { kind?: string; content?: string }).kind === "stream_delta" &&
          (frame as { content?: string }).content === "断线期间内容",
      );
      expect(delta).toBeDefined();
    });
    expect(result.current.reconnectInfo.status).toBe("connected");
  });
});

describe("useGatewayDirectChatProviderState 集成", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    resetGatewayClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/gateway-token") {
          return { ok: true, json: async () => ({ token: "test-token" }) } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("sati-command（带 sessionId）→ submit_turn → 流事件归一化广播", async () => {
    stubWebSocket();
    const received: unknown[] = [];
    const { result } = renderHook(() => useGatewayDirectChatProviderState());
    act(() => {
      result.current.subscribe(message => received.push(message));
    });

    // 等待连接初始化
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    await act(async () => {
      result.current.sendMessage({
        type: "sati-command",
        command: "继续",
        options: { sessionId: "s1", projectPath: "/abs/p" },
      });
    });

    await waitFor(() => {
      const kinds = received.map(frame => (frame as { kind?: string }).kind);
      expect(kinds).toContain("stream_delta");
      expect(kinds).toContain("complete");
    });
    const delta = received.find(frame => (frame as { kind?: string }).kind === "stream_delta") as {
      content?: string;
      sessionId?: string;
    };
    expect(delta.content).toBe("你好");
    expect(delta.sessionId).toBe("s1");
  });

  it("新会话（无 sessionId）→ new_session 后 submit_turn，广播 session_created", async () => {
    stubWebSocket();
    const received: unknown[] = [];
    const { result } = renderHook(() => useGatewayDirectChatProviderState());
    act(() => {
      result.current.subscribe(message => received.push(message));
    });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    await act(async () => {
      result.current.sendMessage({ type: "sati-command", command: "新任务", options: {} });
    });

    await waitFor(() => {
      expect(received.some(frame => (frame as { kind?: string }).kind === "session_created")).toBe(true);
    });
  });

  it("直连 API 与 WebSocketContext 契约对齐（ws=null、subscribe 返回取消函数）", () => {
    // hook mount 会异步 getGatewayClient() → client.connect() → new WebSocket(url)。
    // 此处不 stub WebSocket 会建立真实 undici 连接：本地 gateway 运行时握手成功即触发
    // undici Event 跨 realm 崩溃（"The event argument must be an instance of Event"）
    // 使 vitest 报 unhandled error。stub 后连接走 mock，杜绝真实连接。
    stubWebSocket();
    const { result } = renderHook(() => useGatewayDirectChatProviderState());
    expect(result.current.ws).toBeNull();
    expect(typeof result.current.sendMessage).toBe("function");
    expect(typeof result.current.subscribe).toBe("function");
    expect(result.current.reconnectInfo.status).toBe("disconnected");
    const unsubscribe = result.current.subscribe(() => {});
    expect(typeof unsubscribe).toBe("function");
  });
});

describe("多标签页实时镜像（BroadcastChannel）", () => {
  /** 共享总线 BroadcastChannel mock（复用 gatewayBroadcast.test 的语义）。 */
  class MockBroadcastChannel {
    static instances: MockBroadcastChannel[] = [];
    private listeners: Array<(event: { data?: unknown }) => void> = [];
    constructor(public readonly name: string) {
      MockBroadcastChannel.instances.push(this);
    }
    postMessage(data: unknown): void {
      for (const other of MockBroadcastChannel.instances) {
        if (other === this) continue;
        for (const listener of other.listeners) listener({ data });
      }
    }
    addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
      if (type === "message") this.listeners.push(listener);
    }
    removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
      if (type === "message") this.listeners = this.listeners.filter(item => item !== listener);
    }
    close(): void {}
  }

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    MockBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    resetGatewayClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/gateway-token") {
          return { ok: true, json: async () => ({ token: "test-token" }) } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("标签页 A 的 turn 事件实时镜像到标签页 B（B 不发起 turn）", async () => {
    stubWebSocket();
    const receivedByA: unknown[] = [];
    const receivedByB: unknown[] = [];
    const tabA = renderHook(() => useGatewayDirectChatProviderState());
    const tabB = renderHook(() => useGatewayDirectChatProviderState());
    act(() => {
      tabA.result.current.subscribe(message => receivedByA.push(message));
      tabB.result.current.subscribe(message => receivedByB.push(message));
    });
    await waitFor(() => expect(tabA.result.current.isConnected).toBe(true));

    await act(async () => {
      tabA.result.current.sendMessage({ type: "sati-command", command: "继续", options: { sessionId: "s1" } });
    });

    // A 本地收到（真实流）
    await waitFor(() => {
      expect(receivedByA.some(frame => (frame as { kind?: string }).kind === "stream_delta")).toBe(true);
    });
    // B 经 BroadcastChannel 收到镜像（不经 ws 流）
    await waitFor(() => {
      expect(receivedByB.some(frame => (frame as { kind?: string }).kind === "stream_delta")).toBe(true);
    });
    const deltaB = receivedByB.find(frame => (frame as { kind?: string }).kind === "stream_delta") as {
      content?: string;
      sessionId?: string;
    };
    expect(deltaB.content).toBe("你好");
    expect(deltaB.sessionId).toBe("s1");
  });
});
