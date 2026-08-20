import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "../../../contexts/WebSocketContext";
import type { TeamWireEvent } from "../types";

/**
 * 团队活动事件订阅（自旧 EventStream 迁移）。
 *
 * 数据链路：gateway 按队长会话扇出 `team_event` 帧 → ui/server 桥经 eventMapping
 * 归一为 kind:"team_event" → 本 hook 以 subscribe 累积 50 条滚动窗口。
 *
 * 与旧 EventStream 的差异：**不再调用 useSessionWatch**——agent surface 恒挂载且
 * ChatInterfaceV2 已持有 watch（切换面板时事件订阅仍存活），避免双 watch-session
 * 重复发送。已知限制沿用：emitForSession 仅在队长会话有活跃 turn 时注入事件流，
 * 无活跃 turn 时事件丢失——面板快照 5s 轮询（useTeamPanel）为状态兜底。
 *
 * 消费端按需自 events 派生（DAG/成员行脉冲用最近 N 条窗口切片过滤 teamId，
 * 浮标用 latestEvent），不再提供反向索引——纯派生物，避免与消费端各持一份。
 */

/** 滚动窗口上限：防事件风暴撑爆内存与 DOM。 */
const MAX_EVENTS = 50;

/**
 * 订阅团队事件流。
 * @returns events 滚动窗口（50 条）；latestEvent 最近一条（浮标活动脉冲驱动）。
 */
export function useTeamActivity() {
  const { subscribe } = useWebSocket();
  const [events, setEvents] = useState<TeamWireEvent[]>([]);
  const nextEventIdRef = useRef(0);

  useEffect(
    () =>
      subscribe(message => {
        if (message?.kind !== "team_event") return;
        const event = message.event;
        if (typeof event !== "object" || event === null) return;
        const record = event as TeamWireEvent;
        if (typeof record.type !== "string") return;
        // 自增 id 作 React key：截断窗口内保证稳定唯一
        const eventId = nextEventIdRef.current++;
        setEvents(previous => [...previous.slice(-(MAX_EVENTS - 1)), { ...record, _eventId: eventId }]);
      }),
    [subscribe],
  );

  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  return { events, latestEvent };
}
