import { IS_PLATFORM } from "../../../constants/config";
import type { ShellIncomingMessage, ShellOutgoingMessage } from "../types/types";

export function getShellWebSocketUrl(): string | null {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = localStorage.getItem("auth-token");

  if (IS_PLATFORM || !token) {
    return `${protocol}//${window.location.host}/shell`;
  }

  return `${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`;
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    // 非 JSON 帧 → 返回 null（忽略该消息）。
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
