/** WebSocket 构造器类型：以 `ws` 库的类型为准。 */
export type WebSocketCtor = typeof import("ws").WebSocket;

/**
 * 最小 WebSocket 结构类型：表达 ws 库（EventEmitter 风格 on/once）与
 * Node >= 22 全局 WebSocket（EventTarget 风格 addEventListener）的并集。
 * 渠道在不知道具体实现时用它持有连接实例，避免各自复制接口或引入 any。
 */
export interface MinimalWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  // ws 库形态（EventEmitter）
  on?(event: "message", listener: (data: string | Buffer) => void): void;
  on?(event: "close", listener: () => void): void;
  on?(event: "error", listener: (err: unknown) => void): void;
  once?(event: "open", listener: () => void): void;
  once?(event: "error", listener: (err: unknown) => void): void;
  // Node 全局形态（EventTarget）
  addEventListener?(event: "message", listener: (ev: { data?: unknown }) => void): void;
  addEventListener?(event: "close" | "error", listener: () => void): void;
}

/**
 * 解析 WebSocket 实现：优先 `ws` 库（其 module.exports 本身即 WebSocket 类，
 * 同时带同名属性，两种形态都覆盖），否则回退到 Node >= 22 的全局 WebSocket。
 * 供各渠道适配器复用，避免重复的加载/兜底/报错逻辑。
 */
export function resolveWebSocketImpl(): WebSocketCtor {
  try {
    const wsMod = require("ws") as WebSocketCtor & { WebSocket?: WebSocketCtor };
    return wsMod.WebSocket ?? wsMod;
  } catch {
    const globalWs = (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!globalWs) {
      throw new Error("No WebSocket implementation available (install ws or run on Node >= 22 with global WebSocket).");
    }
    return globalWs;
  }
}
