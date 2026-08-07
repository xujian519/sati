import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWebSocket, WebSocketProvider } from "./WebSocketContext";

vi.mock("../components/auth/context/AuthContext", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

/**
 * 验证 ws state 与连接生命周期同步：
 *  - 连接建立后 useWebSocket().ws 变为 socket 实例（而非陈旧 null）
 *  - 断开后恢复 null
 * 这保证 useSessionWatch 的 socketChanged 分支能感知 socket 就绪。
 */

/** 最近一次构造的 socket，供断言引用。 */
let activeSocket: MockWebSocket | null = null;

class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;

  constructor(_url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 记录最近构造的 socket 供断言引用
    activeSocket = this;
    // 连接在微任务中完成，模拟真实异步握手
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  addEventListener(_type: string, _listener: (event?: unknown) => void) {
    // 代码路径使用 on* 属性赋值，此处无需实现
  }
  removeEventListener(_type: string, _listener: (event?: unknown) => void) {
    // 同上
  }
}

describe("WebSocketProvider ws state 同步", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    activeSocket = null;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it("连接建立后 value.ws 暴露 socket 实例，断开后恢复 null", async () => {
    const { result } = renderHook(() => useWebSocket(), {
      wrapper: ({ children }) => <WebSocketProvider>{children}</WebSocketProvider>,
    });

    // 初始：未连接，ws 为 null
    expect(result.current.ws).toBeNull();

    // 模拟握手完成 → onopen → ws state 更新
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.ws).toBe(activeSocket);
    expect(result.current.isConnected).toBe(true);

    // 断开 → ws 恢复 null
    await act(async () => {
      activeSocket?.close();
      await Promise.resolve();
    });
    expect(result.current.ws).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });
});
