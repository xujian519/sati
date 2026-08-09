/* eslint-disable react-refresh/only-export-components -- context + hook 捆绑导出 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../components/auth/context/AuthContext";
import { IS_PLATFORM } from "../constants/config";

type WSSubscriber = (msg: any) => void;

/**
 * 高频流式增量事件：不进 `latestMessage` state（避免每条流式帧触发
 * 消费 latestMessage 的组件 re-render）。流式渲染应走 subscribe 通道。
 *
 * 浏览器聊天流量经 ui/server 桥转发：`sati-bridge.js` 把 gateway 事件
 * 归一化为 `kind` 帧（stream_delta/thinking/tool_use/tool_result 等，
 * 见 `src/web/client/eventMapping.ts`），因此高频噪声需同时按 `kind`
 * 与 `type` 匹配；结构性事件（session-status/loading_progress/
 * projects_updated/taskmaster-*）不带 kind，仍正常进入 latestMessage。
 */
const STREAMING_NOISE_TYPES = new Set([
  "assistant_text_delta",
  "assistant_thinking_delta",
  "tool_call_delta",
  "tool_call_finished",
  "tool_call_started",
  "agent_status",
]);

/** 桥归一化后高频流式增量的 kind 值（每条可达每秒数十帧）。 */
const STREAMING_NOISE_KINDS = new Set(["stream_delta", "thinking", "tool_use", "tool_result", "agent_activity"]);

// kind 值来源：`src/web/client/eventMapping.ts`（gateway 事件 → kind 帧）与
// `ui/server/sati-bridge.js`（直接构造的 kind 帧）。新增高频 kind 时需同步两处。

export function isStreamingNoise(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const record = data as { type?: unknown; kind?: unknown };
  const type = record.type;
  if (typeof type === "string" && STREAMING_NOISE_TYPES.has(type)) return true;
  const kind = record.kind;
  return typeof kind === "string" && STREAMING_NOISE_KINDS.has(kind);
}

export type ReconnectInfo = {
  attempt: number;
  nextRetryMs: number;
  status: "connected" | "disconnected" | "reconnecting";
};

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  latestMessage: any | null;
  isConnected: boolean;
  reconnectInfo: ReconnectInfo;
  /**
   * Subscribe to every incoming WebSocket message synchronously, bypassing
   * React state batching. Returns an unsubscribe function. Use this for
   * high-frequency event streams (chat stream_delta, etc.) where dropping
   * intermediate values is not acceptable. For low-frequency one-shot events
   * the `latestMessage` state is still fine.
   */
  subscribe: (handler: WSSubscriber) => () => void;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error("useWebSocket must be used within a WebSocketProvider");
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (IS_PLATFORM || !token) return `${protocol}//${window.location.host}/ws`;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
};

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const BACKOFF_FACTOR = 2;
const MAX_QUEUED_MESSAGES = 100;

export function getQueuedMessageKey(message: any): string | null {
  if (message?.type === "check-session-status" && typeof message.sessionId === "string" && message.sessionId.trim()) {
    return `check-session-status:${message.sessionId.trim()}`;
  }
  return null;
}

export function isQueueableDisconnectedMessage(message: any): boolean {
  return getQueuedMessageKey(message) !== null;
}

export function enqueueDisconnectedMessage(queue: any[], message: any, maxQueuedMessages = MAX_QUEUED_MESSAGES): void {
  const key = getQueuedMessageKey(message);
  if (!key) return;
  const existingIndex = queue.findIndex(queuedMessage => getQueuedMessageKey(queuedMessage) === key);
  if (existingIndex >= 0) {
    queue.splice(existingIndex, 1);
  }
  queue.push(message);
  if (queue.length > maxQueuedMessages) {
    queue.splice(0, queue.length - maxQueuedMessages);
  }
}

export function clearDisconnectedQueue(queue: any[]): void {
  queue.splice(0, queue.length);
}

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const connectIdRef = useRef(0);
  // ws 作为 state 暴露给消费者（useSessionWatch 依赖它判断 socket 已连接），
  // 与 wsRef 同步更新；ref 保留供 sendMessage 闭包读取，避免每次连接重建回调。
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectInfo>({
    attempt: 0,
    nextRetryMs: 0,
    status: "disconnected",
  });
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const queuedMessagesRef = useRef<any[]>([]);
  const subscribersRef = useRef<Set<WSSubscriber>>(new Set());
  const { token } = useAuth();

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    const id = ++connectIdRef.current;

    const connect = () => {
      if (unmountedRef.current || connectIdRef.current !== id) return;
      setReconnectInfo(prev => ({ ...prev, status: "reconnecting" }));
      try {
        const wsUrl = buildWebSocketUrl(token);
        if (!wsUrl) return console.warn("No authentication token found for WebSocket connection");

        const websocket = new WebSocket(wsUrl);

        websocket.onopen = () => {
          if (connectIdRef.current !== id) {
            websocket.close();
            return;
          }
          setIsConnected(true);
          reconnectAttemptRef.current = 0;
          setReconnectInfo({ attempt: 0, nextRetryMs: 0, status: "connected" });
          wsRef.current = websocket;
          setWs(websocket);

          while (queuedMessagesRef.current.length > 0 && websocket.readyState === WebSocket.OPEN) {
            const message = queuedMessagesRef.current.shift();
            websocket.send(JSON.stringify(message));
          }

          const pingInterval = setInterval(() => {
            if (websocket.readyState === WebSocket.OPEN) {
              websocket.send(JSON.stringify({ type: "ping" }));
            }
          }, 30_000);
          websocket.addEventListener("close", () => clearInterval(pingInterval));

          if (hasConnectedRef.current) {
            const reconnectMsg = { type: "websocket-reconnected", timestamp: Date.now() };
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach(sub => {
                try {
                  sub(reconnectMsg);
                } catch {
                  /* subscriber errors must not break the reconnect broadcast */
                }
              });
            }
            setLatestMessage(reconnectMsg);
          }
          hasConnectedRef.current = true;
        };

        websocket.onmessage = event => {
          if (connectIdRef.current !== id) return;
          try {
            const data = JSON.parse(event.data);
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach(sub => {
                try {
                  sub(data);
                } catch (err) {
                  console.error("WebSocket subscriber error:", err);
                }
              });
            }
            // 高频流式增量事件（text_delta 等）不进 latestMessage state：
            // 已核实的消费方（useProjectsState/useChatRealtimeHandlers/
            // TaskMasterContext）只消费 loading_progress、projects_updated、
            // session-status、taskmaster-* 等低频结构性事件；流式渲染走
            // subscribe 通道。避免每条流式帧触发 AppShellV2 整树 re-render。
            if (!isStreamingNoise(data)) {
              setLatestMessage(data);
            }
          } catch (error) {
            console.error("Error parsing WebSocket message:", error);
          }
        };

        websocket.onclose = () => {
          if (connectIdRef.current !== id) return;
          setIsConnected(false);
          wsRef.current = null;
          setWs(null);
          const attempt = ++reconnectAttemptRef.current;
          const delay = Math.min(INITIAL_RECONNECT_MS * Math.pow(BACKOFF_FACTOR, attempt - 1), MAX_RECONNECT_MS);
          setReconnectInfo({ attempt, nextRetryMs: delay, status: "disconnected" });
          reconnectTimeoutRef.current = setTimeout(() => {
            if (unmountedRef.current || connectIdRef.current !== id) return;
            connect();
          }, delay);
        };

        websocket.onerror = error => {
          console.error("WebSocket error:", error);
        };
      } catch (error) {
        console.error("Error creating WebSocket connection:", error);
      }
    };

    connect();

    // Copy the ref objects (not their values) so the cleanup closure reads a
    // stable reference; the underlying refs are never re-assigned in this file.
    const connectId = connectIdRef;
    const queuedMessages = queuedMessagesRef;

    return () => {
      connectId.current++;
      clearDisconnectedQueue(queuedMessages.current);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
      setWs(null);
      setIsConnected(false);
    };
  }, [token]);

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else if (isQueueableDisconnectedMessage(message)) {
      enqueueDisconnectedMessage(queuedMessagesRef.current, message);
      console.warn("WebSocket not connected");
    } else {
      console.warn("WebSocket not connected");
    }
  }, []);

  const subscribe = useCallback<WebSocketContextType["subscribe"]>(handler => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const value: WebSocketContextType = useMemo(
    () => ({
      ws,
      sendMessage,
      latestMessage,
      isConnected,
      reconnectInfo,
      subscribe,
    }),
    [ws, sendMessage, latestMessage, isConnected, reconnectInfo, subscribe],
  );

  return value;
};

function LegacyWebSocketProvider({ children }: { children: React.ReactNode }) {
  const webSocketData = useWebSocketProviderState();
  return <WebSocketContext.Provider value={webSocketData}>{children}</WebSocketContext.Provider>;
}

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  // 聊天流量经 ui/server /ws 中转（useSessionWatch + session-watch-registry
  // 中间人）。浏览器直连 gateway 路径已移除。
  return <LegacyWebSocketProvider>{children}</LegacyWebSocketProvider>;
};

export default WebSocketContext;
