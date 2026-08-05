/**
 * P2b-2：连接重连 + snapshot 恢复编排 hook。
 *
 * 状态机：
 *   connected ──ws close──▶ reconnecting ──reconnect() 成功──▶ snapshot_fetching ──▶ connected
 *      │                       │ 失败（onError，保持 reconnecting，可 retry()）
 *      │                       └──── retry() ────────────────┘
 *
 * 恢复语义（与草案 §2 对齐）：重连成功后对每个活跃会话取 `active_turn_snapshot`，
 * 把 `snapshot.events` 全量交给 `replayEvents`（调用方按 runId 重置该会话的实时
 * 增量——"重置式恢复"保证无重复；snapshot 全量保证无丢失）。
 *
 * 与传输解耦：connection 抽象了 GatewayBrowserClient（onDisconnect/reconnect），
 * 便于单测注入 mock。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebGatewayEvent } from "@sati/web-client";

export type ReconnectState = "connected" | "reconnecting" | "snapshot_fetching";

export type GatewayConnectionLike = {
  onDisconnect: (handler: (info: { code?: number; reason?: string }) => void) => void;
  reconnect: () => Promise<unknown>;
};

export type TurnSnapshot = {
  active: boolean;
  sessionKey: string;
  runId?: string;
  events: WebGatewayEvent[];
  truncated?: boolean;
};

export type ReconnectOptions = {
  /** 连接抽象（GatewayBrowserClient 或 mock）。 */
  connection: GatewayConnectionLike;
  /** 当前需要恢复的活跃会话列表。 */
  getActiveSessions: () => string[];
  /** 拉取某会话的 turn snapshot。 */
  fetchSnapshot: (sessionKey: string) => Promise<TurnSnapshot>;
  /** 重放 snapshot 事件（调用方按 runId 重置 + 喂归一化 adapter + store）。 */
  replayEvents: (sessionKey: string, events: WebGatewayEvent[], snapshot: TurnSnapshot) => void;
  /** 恢复完成（进入 connected）后回调。 */
  onRecovered?: (sessionKeys: string[]) => void;
  /** 重连/快照失败回调。 */
  onError?: (error: unknown, phase: "reconnect" | "snapshot") => void;
};

export function useReconnect(options: ReconnectOptions) {
  const { connection, getActiveSessions, fetchSnapshot, replayEvents, onRecovered, onError } = options;
  const [state, setState] = useState<ReconnectState>("connected");
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const runningRef = useRef(false);

  const recover = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      setLastError(undefined);
      setState("reconnecting");
      await connection.reconnect();
      setState("snapshot_fetching");
      const sessions = getActiveSessions();
      const recovered: string[] = [];
      for (const sessionKey of sessions) {
        const snapshot = await fetchSnapshot(sessionKey);
        if (snapshot.active) {
          replayEvents(sessionKey, snapshot.events, snapshot);
          recovered.push(sessionKey);
        }
        // snapshot.active=false：transcript 已是最终态，无需重放
      }
      setState("connected");
      onRecovered?.(recovered);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
      // 失败后保持 reconnecting，等待用户 retry 或连接恢复
      setState("reconnecting");
      onError?.(error, "reconnect");
    } finally {
      runningRef.current = false;
    }
  }, [connection, fetchSnapshot, getActiveSessions, replayEvents, onRecovered, onError]);

  useEffect(() => {
    const handler = () => {
      void recover();
    };
    connection.onDisconnect(handler);
    return () => {
      // 无取消 API；组件卸载后 runningRef 防护 + 状态不再驱动 UI
    };
  }, [connection, recover]);

  const retry = useCallback(() => {
    void recover();
  }, [recover]);

  return { state, lastError, retry };
}
