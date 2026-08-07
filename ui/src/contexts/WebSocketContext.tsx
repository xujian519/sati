/* eslint-disable react-refresh/only-export-components -- context + hook 捆绑导出 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../components/auth/context/AuthContext";
import { useGatewayDirectChatProviderState } from "../chat/useGatewayDirectChat";
import { mapOutgoingMessage } from "../chat/gatewayChatMapper";
import { IS_PLATFORM } from "../constants/config";

type WSSubscriber = (msg: any) => void;

/**
 * 高频流式增量事件：不进 `latestMessage` state（避免每条流式帧触发
 * 消费 latestMessage 的组件 re-render）。流式渲染应走 subscribe 通道。
 */
const STREAMING_NOISE_TYPES = new Set([
  "assistant_text_delta",
  "assistant_thinking_delta",
  "tool_call_delta",
  "tool_call_finished",
  "tool_call_started",
  "agent_status",
]);

function isStreamingNoise(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" && STREAMING_NOISE_TYPES.has(type);
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
  /** 手动重试（直连模式：自动 recover 失败后触发；legacy 模式不提供）。 */
  retryReconnect?: () => void;
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
      ws: wsRef.current,
      sendMessage,
      latestMessage,
      isConnected,
      reconnectInfo,
      subscribe,
    }),
    [sendMessage, latestMessage, isConnected, reconnectInfo, subscribe],
  );

  return value;
};

/**
 * P3 合并式 Provider（直连为唯一路径）：
 *   - 聊天流量（sati-command / abort-session / permission-response /
 *     elicitation-response）→ gateway 直连（useGatewayDirectChatProviderState）；
 *   - 非聊天事件（projects_updated / loading_progress / config:reloaded /
 *     taskmaster-* / session-status 等）→ ui/server /ws 事件通道
 *     （useWebSocketProviderState，降级为只收广播 + 状态查询）。
 * 两条传输合流到同一个 subscribe 通道，Chat 组件零改动。
 */
function UnifiedGatewayWebSocketProvider({ children }: { children: React.ReactNode }) {
  const direct = useGatewayDirectChatProviderState();
  const eventChannel = useWebSocketProviderState();

  // latestMessage 语义与 legacy 一致：只承载事件通道的低频结构性事件
  // （事件通道已在 onmessage 中过滤流式噪声）。聊天流帧（stream_delta 等）
  // 全部经 subscribe 通道分发，不进 latestMessage——避免每条流式帧触发
  // useProjectsState 等消费方 re-render。
  const latestMessage = eventChannel.latestMessage;

  const sendMessage = useCallback(
    (message: any) => {
      const call = mapOutgoingMessage(message);
      if (call.kind === "non_chat") {
        // 非聊天协议帧 → 事件通道（ui/server /ws）。
        eventChannel.sendMessage(message);
      } else if (call.kind !== "ignore") {
        // 聊天帧 → gateway 直连；ignore（缺必要字段的无效聊天帧）直接丢弃，
        // 不泄漏到事件通道。
        direct.sendMessage(message);
      }
    },
    [direct, eventChannel],
  );

  const subscribe = useCallback(
    (handler: WSSubscriber) => {
      const unsubscribeDirect = direct.subscribe(handler);
      const unsubscribeEvents = eventChannel.subscribe(handler);
      return () => {
        unsubscribeDirect();
        unsubscribeEvents();
      };
    },
    [direct, eventChannel],
  );

  const value: WebSocketContextType = useMemo(
    () => ({
      ws: eventChannel.ws,
      sendMessage,
      latestMessage,
      // 聊天是主链路：连接状态/重连信息以 gateway 直连为准。
      isConnected: direct.isConnected,
      reconnectInfo: direct.reconnectInfo,
      retryReconnect: direct.retryReconnect,
      subscribe,
    }),
    [
      eventChannel.ws,
      sendMessage,
      latestMessage,
      direct.isConnected,
      direct.reconnectInfo,
      direct.retryReconnect,
      subscribe,
    ],
  );

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  // P3：直连为唯一路径——聊天流量直连 gateway，ui/server /ws 仅作非聊天事件通道。
  // 原 VITE_GATEWAY_DIRECT_CHAT 双轨开关已随服务端中转退役（P3-5）一并移除。
  return <UnifiedGatewayWebSocketProvider>{children}</UnifiedGatewayWebSocketProvider>;
};

export default WebSocketContext;
