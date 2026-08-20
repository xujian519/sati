import { useEffect, useMemo, useRef, useState } from "react";
import { useWebSocket } from "../../../contexts/WebSocketContext";

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
 */

/** 滚动窗口上限：防事件风暴撑爆内存与 DOM。 */
const MAX_EVENTS = 50;

/** TeamEvent 变体的 wire 形态（浏览器侧局部收窄，不导入 src/）。 */
export type TeamWireEvent = {
  type: string;
  teamId?: string;
  taskId?: string;
  memberId?: string;
  attempt?: number;
  /** 本地自增 React key（非后端字段）。 */
  _eventId?: number;
  [key: string]: unknown;
};

/** 事件族徽章配色（按 type 精确映射；未知事件兜底中性灰）。 */
export const EVENT_STYLE: Record<string, string> = {
  task_claimed: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400",
  task_completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400",
  task_failed: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400",
  task_retried: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
  message_delivered: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-400",
};

export const FALLBACK_EVENT_STYLE = "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";

export const describeEvent = (event: TeamWireEvent): string => {
  const parts = [event.taskId, event.memberId];
  if (typeof event.attempt === "number") parts.push(`attempt:${event.attempt}`);
  if (event.teamId !== undefined) parts.push(event.teamId);
  return parts.filter(Boolean).join(" · ");
};

/**
 * 订阅团队事件流。
 * @returns events 滚动窗口；eventsForTask/eventsForMember 反向索引（供 DAG 节点/
 *   成员行活动指示与浮标脉冲共用）；latestEvent 最近一条（浮标脉冲驱动）。
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

  const indexes = useMemo(() => {
    const byTask = new Map<string, TeamWireEvent[]>();
    const byMember = new Map<string, TeamWireEvent[]>();
    for (const event of events) {
      if (event.taskId !== undefined) {
        const bucket = byTask.get(event.taskId) ?? [];
        bucket.push(event);
        byTask.set(event.taskId, bucket);
      }
      if (event.memberId !== undefined) {
        const bucket = byMember.get(event.memberId) ?? [];
        bucket.push(event);
        byMember.set(event.memberId, bucket);
      }
    }
    return { byTask, byMember };
  }, [events]);

  const eventsForTask = (taskId: string): TeamWireEvent[] => indexes.byTask.get(taskId) ?? [];
  const eventsForMember = (memberId: string): TeamWireEvent[] => indexes.byMember.get(memberId) ?? [];
  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  return { events, eventsForTask, eventsForMember, latestEvent };
}
