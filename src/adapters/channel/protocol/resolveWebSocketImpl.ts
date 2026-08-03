/** WebSocket 构造器类型：以 `ws` 库的类型为准。 */
export type WebSocketCtor = typeof import("ws").WebSocket;

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
