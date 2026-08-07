/**
 * P2b-3：gateway 直连聊天的 WebSocketContext 等价实现（provider state hook）。
 *
 * 与 `WebSocketContext.useWebSocketProviderState` 返回同构的
 * `{ ws, sendMessage, latestMessage, isConnected, reconnectInfo, subscribe }`，
 * 使 Chat 组件在直连模式下零改动：
 *   - 发送：ws 帧 → `mapOutgoingMessage` → gateway 协议调用（submit_turn /
 *     new_session + submit_turn / abort_turn / permission_decide / elicitation_respond）
 *   - 接收：submitTurn 流事件 → `gatewayEventToChatFrames` → 广播给 subscribe handlers
 *   - 断线：client.onDisconnect → 自动 reconnect（reconnectInfo 同步）
 *
 * 限制（P2b-3 明确）：不做多会话快照恢复（依赖 transcript 重载兜底）、
 * 不做并发 turn 排队（gateway 侧行为决定）；P2b-4 完善多标签页。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayBrowserClient } from "@sati/web-client";
import { getGatewayClient } from "../utils/api";
import { createChatBroadcast } from "./gatewayBroadcast";
import type { ChatBroadcast } from "./gatewayBroadcast";
import { AlwaysOnTurnForwarder } from "./alwaysOnTurnForwarder";
import { gatewayEventToChatFrames } from "./gatewayEventAdapter";
import { mapOutgoingMessage } from "./gatewayChatMapper";
import type { SubmitTurnLike } from "./gatewayChatMapper";
import { useReconnect } from "./useReconnect";
import type { TurnSnapshot } from "./useReconnect";

type Subscriber = (message: unknown) => void;

type ReconnectInfoLike = {
  attempt: number;
  nextRetryMs: number;
  status: "connected" | "disconnected" | "reconnecting";
};

const CONNECTED: ReconnectInfoLike = { attempt: 0, nextRetryMs: 0, status: "connected" };
const DISCONNECTED: ReconnectInfoLike = { attempt: 0, nextRetryMs: 0, status: "disconnected" };
const RECONNECTING: ReconnectInfoLike = { attempt: 1, nextRetryMs: 0, status: "reconnecting" };

export function useGatewayDirectChatProviderState() {
  const subscribersRef = useRef<Set<Subscriber>>(new Set());
  const clientRef = useRef<GatewayBrowserClient | null>(null);
  const broadcastRef = useRef<ChatBroadcast | null>(null);
  const activeSessionsRef = useRef<Set<string>>(new Set());
  const [latestMessage, setLatestMessage] = useState<unknown>(null);
  const [clientReady, setClientReady] = useState(false);

  const broadcastLocal = useCallback((frame: unknown) => {
    setLatestMessage(frame);
    for (const subscriber of subscribersRef.current) {
      try {
        subscriber(frame);
      } catch (error) {
        console.error("Gateway chat subscriber error:", error);
      }
    }
  }, []);

  // 跨标签页实时镜像：本地帧（带 sessionId）广播给其他标签页；
  // 其他标签页广播的帧经 broadcastLocal 分发（handlers 按 sessionId 路由）。
  const broadcast = useCallback(
    (frame: unknown) => {
      broadcastLocal(frame);
      const sessionId = (frame as { sessionId?: unknown })?.sessionId;
      if (typeof sessionId === "string" && sessionId) {
        broadcastRef.current ??= createChatBroadcast();
        broadcastRef.current.post(sessionId, frame);
      }
    },
    [broadcastLocal],
  );

  // 断线重连编排（useReconnect）：重连成功后对活跃会话取 active_turn_snapshot 全量重放。
  const replaySnapshotEvents = useCallback(
    (sessionKey: string, events: TurnSnapshot["events"]) => {
      for (const event of events) {
        const frames = gatewayEventToChatFrames(event, sessionKey);
        for (const frame of frames) broadcastLocal(frame);
      }
    },
    [broadcastLocal],
  );

  // client 异步初始化：mount 时 onDisconnect 可能尚未就绪，入队待 client 就绪后补注册。
  const pendingDisconnectHandlersRef = useRef<Array<(info: { code?: number; reason?: string }) => void>>([]);
  const connection = useMemo(
    () => ({
      onDisconnect: (handler: (info: { code?: number; reason?: string }) => void) => {
        if (clientRef.current) {
          clientRef.current.onDisconnect(handler);
        } else {
          pendingDisconnectHandlersRef.current.push(handler);
        }
      },
      reconnect: () =>
        clientRef.current ? clientRef.current.reconnect() : Promise.reject(new Error("Gateway client not ready.")),
    }),
    [],
  );

  const { state: reconnectState, retry: retryReconnect } = useReconnect({
    connection,
    getActiveSessions: () => [...activeSessionsRef.current],
    fetchSnapshot: async sessionKey =>
      (await clientRef.current?.request("active_turn_snapshot", { sessionKey })) as TurnSnapshot,
    replayEvents: (sessionKey, events) => replaySnapshotEvents(sessionKey, events),
    // 恢复完成后移除活跃标记（断线保留的会话）
    onRecovered: sessions => {
      for (const sessionKey of sessions) {
        activeSessionsRef.current.delete(sessionKey);
      }
    },
  });

  const isConnected = clientReady && reconnectState === "connected" && Boolean(clientRef.current?.connected);
  const reconnectInfo: ReconnectInfoLike = useMemo(() => {
    if (reconnectState === "connected" && isConnected) return CONNECTED;
    if (reconnectState === "reconnecting" || reconnectState === "snapshot_fetching") return RECONNECTING;
    return DISCONNECTED;
  }, [reconnectState, isConnected]);

  // 连接初始化 + 断线自动重连 + 跨标签页广播订阅
  useEffect(() => {
    let cancelled = false;
    const tabBroadcast = createChatBroadcast();
    broadcastRef.current = tabBroadcast;
    const unsubscribeTab = tabBroadcast.subscribe(envelope => {
      if (cancelled) return;
      broadcastLocal(envelope.frame);
    });
    let unsubscribeNotification: (() => void) | null = null;
    (async () => {
      try {
        const client = await getGatewayClient();
        if (cancelled) return;
        clientRef.current = client;
        // 补注册 mount 期间积压的断线订阅（useReconnect 在 mount 时注册）
        for (const handler of pendingDisconnectHandlersRef.current) {
          client.onDisconnect(handler);
        }
        pendingDisconnectHandlersRef.current = [];
        // Always-On turn 事件直收（P3）：gateway 对全部 ws 连接广播，每个
        // 标签页各自收到，故只走 broadcastLocal，不再经 BroadcastChannel
        // 跨标签页转发（否则镜像会重复）。forwarder 与本次挂载同生命周期，
        // cleanup 中注销 handler。
        const forwarder = new AlwaysOnTurnForwarder(broadcastLocal);
        unsubscribeNotification = client.onNotification((name: string, payload: unknown) =>
          forwarder.handleNotification(name, payload),
        );
        setClientReady(true);
      } catch {
        // gateway 未启动/token 不可用：保持 disconnected，sendMessage 会重试
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
      unsubscribeNotification?.();
      unsubscribeTab();
      tabBroadcast.close();
    };
  }, [broadcastLocal]);

  const runTurn = useCallback(
    async (client: GatewayBrowserClient, input: SubmitTurnLike) => {
      activeSessionsRef.current.add(input.sessionKey);
      try {
        const stream = client.submitTurn(input);
        for await (const event of stream) {
          const frames = gatewayEventToChatFrames(event, input.sessionKey);
          for (const frame of frames) broadcast(frame);
        }
      } catch {
        // 非断线错误（如 gateway 拒绝）→ 移除活跃标记
        activeSessionsRef.current.delete(input.sessionKey);
        return;
      }
      // 流结束：正常完成（connected）→ 移除；断线中断（AsyncEventQueue.fail 对挂起
      // waiter 静默 done，for await 正常退出不抛错）→ 保留活跃标记，由 useReconnect
      // 快照恢复接管（onRecovered 后移除）。
      if (client.connected) {
        activeSessionsRef.current.delete(input.sessionKey);
      }
    },
    [broadcast],
  );

  const sendMessage = useCallback(
    async (message: unknown) => {
      const call = mapOutgoingMessage(message as Parameters<typeof mapOutgoingMessage>[0]);
      // ignore：聊天帧但缺必要字段，丢弃；non_chat：非聊天协议帧，直连模式不转发。
      if (call.kind === "ignore" || call.kind === "non_chat") return;
      try {
        const client = await getGatewayClient();
        if (call.kind === "submit_turn") {
          await runTurn(client, call.input);
        } else if (call.kind === "new_session_then_submit") {
          const { sessionKey } = await client.newSession(call.newSession);
          broadcast({ kind: "session_created", newSessionId: sessionKey, sessionKey, provider: "sati" });
          await runTurn(client, { ...call.submit, sessionKey });
        } else if (call.kind === "abort_turn") {
          await client.abortTurn(call.input);
        } else if (call.kind === "permission_decide") {
          await client.request("permission_decide", call.input);
        } else if (call.kind === "elicitation_respond") {
          await client.request("elicitation_respond", call.input);
        }
      } catch (error) {
        console.error("Gateway direct chat error:", error);
        broadcast({
          kind: "error",
          content: error instanceof Error ? error.message : String(error),
          code: "gateway_direct_send_failed",
          recoverable: true,
          provider: "sati",
        });
      }
    },
    [broadcast, runTurn],
  );

  const subscribe = useCallback((handler: Subscriber) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  return useMemo(
    () => ({
      ws: null,
      sendMessage,
      latestMessage,
      isConnected,
      reconnectInfo,
      subscribe,
      // 手动重试：自动 recover 失败后（保持 reconnecting）用户可主动触发
      retryReconnect: retryReconnect,
    }),
    [sendMessage, latestMessage, isConnected, reconnectInfo, subscribe, retryReconnect],
  );
}
